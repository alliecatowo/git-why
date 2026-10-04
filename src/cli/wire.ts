/**
 * Wiring seam between the CLI and the rest of the system.
 *
 * This is the one place where the lanes are composed: Git supplies the
 * repository identity, snapshot and reachable set; the embedding lane supplies
 * the model; the storage lane owns generations, locks and the collection; the
 * search lane turns a request into ranked commits.
 *
 * `GIT_WHY_TEST_BACKEND` is a deliberate, permanent test seam, not a temporary
 * hack: `test/integration/cli/` spawns the built `dist/cli/main.js` as a real
 * child process and points this variable at a compiled fake-backend module.
 * That lets the whole CLI — argument parsing, process and exit handling, human
 * and JSON rendering — run for real against a deterministic in-process fake,
 * without a real Git repository, model or Zvec index.
 */

import { loadDefaultEmbedder } from '../embedding/index.js';
import { runGit } from '../git/exec.js';
import { createGitHistoryExtractor } from '../git/extract.js';
import { enumerateReachable } from '../git/reachable.js';
import { resolveRepositoryIdentity } from '../git/repository.js';
import { captureSnapshot } from '../git/snapshot.js';
import {
  assertModelCompatible,
  ensureCurrentGeneration,
  gc as gcGenerations,
  openReadOnlyStore,
  rebuild as rebuildGeneration,
  type ReachableSet,
  type RefreshOptions,
  type StorageDeps,
} from '../index/refresh.js';
import type { ManifestOmissionCounts } from '../index/manifest.js';
import { computeIndexStatus } from '../index/status.js';
import { generationPaths, layoutFor, readCurrentGenerationId } from '../index/layout.js';
import { readManifest } from '../index/manifest.js';
import { JsonLineageStore } from '../history/lineage.js';
import { search as runSearch, type AnchorTimeResolver } from '../search/search.js';
import {
  GitWhyError,
  type Embedder,
  type IndexStatus,
  type RepositorySnapshot,
  type SearchRequest,
  type SearchResponse,
  type SnapshotSummary,
} from '../types.js';
import type {
  Backend,
  RebuildOptions,
  RepositoryHandle,
  RunOptions,
  StatusOptions,
} from './ports.js';

/**
 * `--offline` forbids downloading model artifacts. It does not forbid using an
 * already cached model, which is the ordinary offline case.
 */
async function loadEmbedder(options: {
  offline: boolean;
  onProgress: RunOptions['onProgress'];
}): Promise<Embedder> {
  options.onProgress({ stage: 'model', message: 'loading embedding model' });
  // The cache reports every chunk. Emitting one stderr line per chunk buries
  // the actual stages, so only report a file starting and each 25% step.
  const lastStep = new Map<string, number>();
  return loadDefaultEmbedder({
    offline: options.offline,
    onProgress: (p) => {
      const step =
        p.totalBytes === null || p.totalBytes === 0
          ? 0
          : Math.floor((p.bytesDownloaded / p.totalBytes) * 4);
      if (lastStep.get(p.file) === step) return;
      lastStep.set(p.file, step);
      // Content-Length is optional, so a percentage is not always available.
      const detail =
        p.totalBytes === null || p.totalBytes === 0
          ? ''
          : ` (${Math.round((p.bytesDownloaded / p.totalBytes) * 100)}%)`;
      options.onProgress({ stage: 'model', message: `downloading ${p.file}${detail}` });
    },
  });
}

/** Any recorded omission means the corpus is partial for the current policy. */
export function coverageSummaryOf(omissions: ManifestOmissionCounts): SnapshotSummary['coverage'] {
  const anyOmission =
    omissions.excludedFiles > 0 ||
    omissions.unavailableFiles > 0 ||
    omissions.failedFiles > 0 ||
    omissions.reasons.length > 0;
  return anyOmission ? 'partial' : 'complete_for_policy';
}

export function toSnapshotSummary(
  snapshot: RepositorySnapshot,
  generation: string,
  indexedAt: string | null,
  freshness: SnapshotSummary['freshness'],
  coverage: SnapshotSummary['coverage'],
): SnapshotSummary {
  return {
    scope: 'branches-remotes-tags-worktree-heads',
    fingerprint: snapshot.fingerprint,
    indexedAt,
    freshness,
    coverage,
    generation,
  };
}

/**
 * A snapshot whose worktree enumeration failed may add records but must never
 * prune, so the reachable set carries the snapshot's completeness forward.
 */
async function captureReachable(handle: RepositoryHandle): Promise<{
  snapshot: RepositorySnapshot;
  reachable: ReachableSet;
}> {
  const snapshot = await captureSnapshot(handle.identity);
  const shas = await enumerateReachable(handle.identity, snapshot.tipOids);
  return { snapshot, reachable: { shas, complete: snapshot.complete } };
}

function refreshOptions(options: RunOptions): RefreshOptions {
  return {
    lockTimeoutSeconds: Math.max(1, Math.round(options.lockTimeoutMs / 1000)),
    noRefresh: options.noRefresh,
  };
}

async function storageDeps(options: RunOptions): Promise<StorageDeps> {
  const embedder = await loadEmbedder(options);
  return { embedder, extractor: createGitHistoryExtractor(embedder) };
}

/**
 * Status is read-only by contract: it must never download a model, repair
 * storage or start indexing. It therefore does a cheap fingerprint comparison
 * rather than a full reconciliation.
 */
async function statusOf(handle: RepositoryHandle, _options: StatusOptions): Promise<IndexStatus> {
  const { identity } = handle;
  let fingerprint: string | null = null;
  let refsChanged = false;
  let reachableCommits: number | null = null;
  try {
    const snapshot = await captureSnapshot(identity);
    fingerprint = snapshot.fingerprint;
    try {
      // `enumerateReachable` is a plain `git rev-list --stdin` walk over
      // already-resolved tip OIDs: no model load, no index read or write.
      // It is a property of the repository, not of the index, so `status`
      // can report it even when no index has ever been built — and must
      // never report "unknown" for a number it can cheaply compute. A
      // failure here is kept independent of fingerprint capture: it must
      // not be misreported as the refs having moved.
      reachableCommits = (await enumerateReachable(identity, snapshot.tipOids)).length;
    } catch {
      // leave reachableCommits null; the rest of the status is still valid.
    }
  } catch {
    // A snapshot we cannot capture is reported as an unknown view rather than
    // as a broken index; status never repairs anything.
    refsChanged = true;
  }
  return computeIndexStatus({
    commonDir: identity.commonDir,
    objectFormat: identity.objectFormat,
    shallow: identity.isShallow,
    currentSnapshotFingerprint: fingerprint,
    refsChanged,
    reachableCommits,
  });
}

/**
 * `openReadOnlyStore` (owned by the storage lane) raises bare `INDEX_MISSING`
 * with no hint. The CLI contract requires both the human and JSON error
 * forms to tell the user exactly what to do, so the hint is attached here at
 * the CLI/backend seam rather than upstream.
 */
async function withIndexMissingHint<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (err) {
    if (err instanceof GitWhyError && err.code === 'INDEX_MISSING' && err.hint === undefined) {
      throw new GitWhyError('INDEX_MISSING', err.message, {
        exitCode: err.exitCode,
        hint: 'run `git why index` (or drop --no-refresh)',
        cause: err.cause,
      });
    }
    throw err;
  }
}

function readCurrentManifest(commonDir: string) {
  const layout = layoutFor(commonDir);
  try {
    const id = readCurrentGenerationId(layout);
    return id === null ? null : readManifest(generationPaths(layout, id).manifestFile);
  } catch {
    // A missing or corrupt manifest means there is no recorded model to protect.
    return null;
  }
}

class RealBackend implements Backend {
  async openRepository(cwd: string): Promise<RepositoryHandle> {
    return { identity: await resolveRepositoryIdentity(cwd) };
  }

  async getStatus(repo: RepositoryHandle, options: StatusOptions): Promise<IndexStatus> {
    return statusOf(repo, options);
  }

  async search(
    repo: RepositoryHandle,
    request: SearchRequest,
    options: RunOptions,
  ): Promise<SearchResponse> {
    // `--text` against a current index must not load the embedding model at
    // all, which is what makes `--text --no-refresh` usable offline when the
    // model is unavailable.
    const needsEmbedder = request.mode !== 'text';

    if (options.noRefresh) {
      // Load the embedder first so the recorded model can be verified before
      // the collection is opened.
      const embedder = needsEmbedder ? await loadEmbedder(options) : null;
      const opened = await withIndexMissingHint(
        openReadOnlyStore(repo.identity, {
          ...refreshOptions(options),
          ...(embedder !== null ? { embedder } : {}),
        }),
      ).catch(async (err: unknown) => {
        await embedder?.dispose();
        throw err;
      });
      try {
        const lineage = new JsonLineageStore(
          generationPaths(layoutFor(repo.identity.commonDir), opened.generationId).lineageFile,
        );
        const snapshot = await captureSnapshot(repo.identity);
        const fresh = snapshot.fingerprint === opened.manifest.snapshotFingerprint;
        const summary = toSnapshotSummary(
          snapshot,
          opened.generationId,
          opened.manifest.updatedAt,
          fresh ? 'current' : 'stale',
          coverageSummaryOf(opened.manifest.omissions),
        );
        return await runSearch(
          request,
          opened.store,
          embedder,
          summary,
          lineage,
          anchorResolverFor(repo.identity.commonDir),
        );
      } finally {
        await opened.store.close();
        opened.lock.release();
        await embedder?.dispose();
      }
    }

    const { snapshot, reachable } = await captureReachable(repo);
    const deps = await storageDeps(options);
    try {
      return await this.#searchRefreshed(repo, request, options, deps, snapshot, reachable);
    } finally {
      await deps.embedder.dispose();
    }
  }

  async #searchRefreshed(
    repo: RepositoryHandle,
    request: SearchRequest,
    options: RunOptions,
    deps: StorageDeps,
    snapshot: RepositorySnapshot,
    reachable: ReachableSet,
  ): Promise<SearchResponse> {
    const needsEmbedder = request.mode !== 'text';
    const ensured = await ensureCurrentGeneration(repo.identity, snapshot, reachable, deps, {
      ...refreshOptions(options),
      checkModel: needsEmbedder,
    });

    const opened = await withIndexMissingHint(
      openReadOnlyStore(repo.identity, {
        ...refreshOptions(options),
        ...(needsEmbedder ? { embedder: deps.embedder } : {}),
      }),
    );
    try {
      const lineage = new JsonLineageStore(
        generationPaths(layoutFor(repo.identity.commonDir), opened.generationId).lineageFile,
      );
      const summary = toSnapshotSummary(
        snapshot,
        ensured.generationId,
        ensured.manifest.updatedAt,
        'current',
        coverageSummaryOf(ensured.manifest.omissions),
      );
      return await runSearch(
        request,
        opened.store,
        needsEmbedder ? deps.embedder : null,
        summary,
        lineage,
        anchorResolverFor(repo.identity.commonDir),
      );
    } finally {
      await opened.store.close();
      opened.lock.release();
    }
  }

  async index(repo: RepositoryHandle, options: RunOptions): Promise<IndexStatus> {
    if (options.noRefresh) {
      throw new GitWhyError(
        'INVALID_ARGUMENTS',
        '--no-refresh cannot be combined with `git why index`',
        {
          hint: 'Drop --no-refresh to build or reconcile the index.',
        },
      );
    }
    const { snapshot, reachable } = await captureReachable(repo);
    const deps = await storageDeps(options);
    try {
      // `index` explicitly retries obtainable missing evidence, unlike an
      // ordinary query, which does not re-attempt unchanged missing blobs.
      await ensureCurrentGeneration(repo.identity, snapshot, reachable, deps, {
        ...refreshOptions(options),
        forceRetryIncomplete: true,
      });
    } finally {
      await deps.embedder.dispose();
    }
    return statusOf(repo, options);
  }

  async rebuild(repo: RepositoryHandle, options: RebuildOptions): Promise<IndexStatus> {
    if (options.noRefresh) {
      throw new GitWhyError(
        'INVALID_ARGUMENTS',
        '--no-refresh cannot be combined with `git why rebuild`',
        {
          hint: 'Drop --no-refresh to rebuild the index.',
        },
      );
    }
    const { snapshot, reachable } = await captureReachable(repo);
    const deps = await storageDeps(options);
    try {
      if (!options.useDefaultModel) {
        // Without explicit consent a rebuild keeps the index's recorded model;
        // a different default is a migration the user must ask for.
        const current = readCurrentManifest(repo.identity.commonDir);
        if (current !== null) assertModelCompatible(current, deps.embedder);
      }
      await rebuildGeneration(repo.identity, snapshot, reachable, deps, refreshOptions(options));
    } finally {
      await deps.embedder.dispose();
    }
    return statusOf(repo, options);
  }

  async gc(repo: RepositoryHandle, options: RunOptions): Promise<IndexStatus> {
    if (options.noRefresh) {
      throw new GitWhyError(
        'INVALID_ARGUMENTS',
        '--no-refresh cannot be combined with `git why gc`',
        {
          hint: 'Drop --no-refresh to compact the index.',
        },
      );
    }
    // gc reconciles without downloading embeddings, so no model is loaded here.
    options.onProgress({ stage: 'gc', message: 'removing abandoned generations' });
    await gcGenerations(repo.identity, refreshOptions(options));
    return statusOf(repo, options);
  }
}

/** Resolves tag/sha anchors to a committer time using the repository itself. */
function anchorResolverFor(commonDir: string): AnchorTimeResolver {
  return async (anchor) => {
    const name = anchor.kind === 'tag' ? anchor.name : anchor.kind === 'sha' ? anchor.sha : null;
    if (name === null || name.startsWith('-')) return null;
    const result = await runGit({
      gitDir: commonDir,
      cwd: commonDir,
      args: ['show', '-s', '--format=%ct', `${name}^{commit}`, '--'],
    });
    if (result.code !== 0) return null;
    const time = Number(result.stdout.toString('utf8').trim());
    return Number.isFinite(time) ? time : null;
  };
}

export async function createBackend(): Promise<Backend> {
  const testBackendPath = process.env.GIT_WHY_TEST_BACKEND;
  if (testBackendPath && process.env.NODE_ENV === 'test') {
    const mod = (await import(testBackendPath)) as {
      default?: Backend;
      createBackend?: () => Backend;
    };
    const backend = mod.default ?? mod.createBackend?.();
    if (!backend) {
      throw new Error(
        `GIT_WHY_TEST_BACKEND module at "${testBackendPath}" has no default export or createBackend() factory.`,
      );
    }
    return backend;
  }

  return new RealBackend();
}
