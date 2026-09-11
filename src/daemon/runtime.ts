/**
 * Per-repository warm state for the daemon.
 *
 * `Backend.search()` reopens the collection, reloads the embedding model and
 * rereads the lineage table on every call, then closes it all again. In a
 * one-shot CLI that is correct — the process is about to exit. In a resident
 * process it is the entire reason a resident process would otherwise buy
 * nothing: measured back-to-back in one process, query eight was no faster
 * than query one.
 *
 * The structure mirrors `zg`'s daemon, which solves the same problem: a model
 * pool shared across workspaces, a per-workspace runtime, and a read-session
 * cache that closes on idle. Keeping the shapes aligned is deliberate — it is
 * a design that has already had the corners knocked off it in production.
 *
 * What is held:
 *   - the open Zvec collection and its shared lock, per repository
 *   - the embedding model, shared across every repository
 *   - the lineage store, per repository (lazy inside itself, so a repository
 *     that never runs an ordinal query never pays for it)
 *
 * What is deliberately NOT held: the refs snapshot. It is ~16 ms to capture
 * and it is the one thing that goes stale the instant someone fetches, so it
 * is recomputed per request and used to decide whether the warm handles are
 * still valid.
 */

import { JsonLineageStore } from '../history/lineage.js';
import { generationPaths, layoutFor } from '../index/layout.js';
import { openReadOnlyStore } from '../index/refresh.js';
import { captureSnapshot } from '../git/snapshot.js';
import { resolveRepositoryIdentity } from '../git/repository.js';
import { loadDefaultEmbedder } from '../embedding/index.js';
import type { Embedder, LineageStore, RepositoryIdentity } from '../types.js';

type OpenedStore = Awaited<ReturnType<typeof openReadOnlyStore>>;

/** Default idle window before a repository's handles are released. */
export const DEFAULT_IDLE_TTL_MS = 15 * 60_000;

/**
 * The embedding model, loaded once per daemon rather than once per repository.
 *
 * A machine with ten indexed repositories should hold one model, not ten. The
 * model is immutable once loaded and every caller uses it read-only, so a
 * single instance is safe to share.
 */
class ModelPool {
  #model: Promise<Embedder> | null = null;

  async acquire(): Promise<Embedder> {
    this.#model ??= loadDefaultEmbedder({ offline: false, onProgress: () => {} });
    try {
      return await this.#model;
    } catch (err) {
      // A failed load must not be cached, or every later request inherits a
      // failure that may have been transient (a download interrupted once).
      this.#model = null;
      throw err;
    }
  }

  async close(): Promise<void> {
    const model = this.#model;
    this.#model = null;
    if (model === null) return;
    await (await model).dispose?.();
  }
}

interface RepoRuntime {
  readonly identity: RepositoryIdentity;
  opened: OpenedStore;
  lineage: LineageStore;
  /** The refs fingerprint the open generation was validated against. */
  fingerprint: string;
  generationId: string;
  lastUsedAt: number;
  /** In-flight requests; handles are never closed with a reader inside. */
  readers: number;
  idleTimer: NodeJS.Timeout | null;
}

export interface RuntimeLease {
  readonly identity: RepositoryIdentity;
  readonly store: OpenedStore['store'];
  readonly manifest: OpenedStore['manifest'];
  readonly generationId: string;
  readonly lineage: LineageStore;
  readonly embedder: Embedder;
  readonly snapshotFingerprint: string;
  readonly stale: boolean;
  release(): void;
}

export class RuntimeManager {
  readonly #runtimes = new Map<string, RepoRuntime>();
  readonly #opening = new Map<string, Promise<RepoRuntime>>();
  readonly #models = new ModelPool();
  readonly #idleTtlMs: number;
  #closed = false;

  constructor(options: { idleTtlMs?: number } = {}) {
    this.#idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  }

  /**
   * Acquires warm handles for a repository, opening them if necessary.
   *
   * The caller MUST call `release()`. Handles are reference-counted because an
   * idle sweep that closed a collection out from under an in-flight query
   * would surface as a storage error to a user who did nothing wrong.
   */
  async acquire(cwd: string, options: { needsEmbedder: boolean }): Promise<RuntimeLease> {
    if (this.#closed) throw new Error('daemon is shutting down');
    const identity = await resolveRepositoryIdentity(cwd);
    const key = identity.commonDir;

    // Captured before the handles are reused: if refs moved, the open
    // generation may no longer cover the repository, and serving from it
    // silently would answer from a history that no longer exists.
    const snapshot = await captureSnapshot(identity);

    let runtime = this.#runtimes.get(key);
    if (runtime !== undefined && runtime.fingerprint !== snapshot.fingerprint) {
      // Refs moved. The generation itself may still be the current one — a
      // fetch that changed no indexed commit leaves it valid — so revalidate
      // rather than assuming either way.
      await this.#evict(key, runtime);
      runtime = undefined;
    }

    if (runtime === undefined) {
      runtime = await this.#open(key, identity, snapshot.fingerprint);
    }

    runtime.readers += 1;
    runtime.lastUsedAt = Date.now();
    if (runtime.idleTimer !== null) {
      clearTimeout(runtime.idleTimer);
      runtime.idleTimer = null;
    }

    const embedder = options.needsEmbedder ? await this.#models.acquire() : (null as never);
    const current = runtime;
    let released = false;
    return {
      identity,
      store: current.opened.store,
      manifest: current.opened.manifest,
      generationId: current.generationId,
      lineage: current.lineage,
      embedder,
      snapshotFingerprint: snapshot.fingerprint,
      stale: current.opened.manifest.snapshotFingerprint !== snapshot.fingerprint,
      release: () => {
        if (released) return;
        released = true;
        current.readers -= 1;
        current.lastUsedAt = Date.now();
        if (current.readers === 0) this.#scheduleIdleClose(key, current);
      },
    };
  }

  async #open(
    key: string,
    identity: RepositoryIdentity,
    fingerprint: string,
  ): Promise<RepoRuntime> {
    // Two concurrent requests for a cold repository must open it once. Without
    // this, both open the collection and one of the two shared locks is
    // leaked for the lifetime of the daemon.
    let pending = this.#opening.get(key);
    if (pending === undefined) {
      // The cleanup MUST NOT be attached with `.finally()`. That returns a new
      // promise which inherits the rejection, and if nothing awaits that one it
      // is an unhandled rejection — which in Node terminates the process. A
      // single request against a repository with no index therefore killed the
      // daemon and every other repository's warm state with it. Observed, not
      // theorised: `git why status` in an unindexed clone took the daemon down.
      pending = (async () => {
        const opened = await openReadOnlyStore(identity, {});
        const lineage = new JsonLineageStore(
          generationPaths(layoutFor(identity.commonDir), opened.generationId).lineageFile,
        );
        const runtime: RepoRuntime = {
          identity,
          opened,
          lineage,
          fingerprint,
          generationId: opened.generationId,
          lastUsedAt: Date.now(),
          readers: 0,
          idleTimer: null,
        };
        this.#runtimes.set(key, runtime);
        return runtime;
      })();
      this.#opening.set(key, pending);
      const forget = () => this.#opening.delete(key);
      // Two handlers on the SAME promise: the rejection is consumed here and
      // also propagates to the caller that awaits `pending` below.
      pending.then(forget, forget);
    }
    return pending;
  }

  #scheduleIdleClose(key: string, runtime: RepoRuntime): void {
    if (runtime.idleTimer !== null) clearTimeout(runtime.idleTimer);
    runtime.idleTimer = setTimeout(() => {
      void this.#evict(key, runtime);
    }, this.#idleTtlMs);
    // A pending idle sweep must not keep the process alive on its own.
    runtime.idleTimer.unref?.();
  }

  async #evict(key: string, runtime: RepoRuntime): Promise<void> {
    if (runtime.readers > 0) {
      // Something acquired it between the timer firing and now. Leave it.
      this.#scheduleIdleClose(key, runtime);
      return;
    }
    if (this.#runtimes.get(key) === runtime) this.#runtimes.delete(key);
    if (runtime.idleTimer !== null) clearTimeout(runtime.idleTimer);
    try {
      await runtime.opened.store.close();
    } finally {
      runtime.opened.lock.release();
    }
  }

  snapshot(): { repositories: number; openReaders: number } {
    let openReaders = 0;
    for (const r of this.#runtimes.values()) openReaders += r.readers;
    return { repositories: this.#runtimes.size, openReaders };
  }

  async close(): Promise<void> {
    this.#closed = true;
    const runtimes = [...this.#runtimes.entries()];
    this.#runtimes.clear();
    for (const [, runtime] of runtimes) {
      if (runtime.idleTimer !== null) clearTimeout(runtime.idleTimer);
      try {
        await runtime.opened.store.close();
      } finally {
        runtime.opened.lock.release();
      }
    }
    await this.#models.close();
  }
}
