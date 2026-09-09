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
import { createGitHistoryExtractor } from '../git/extract.js';
import { enumerateReachable } from '../git/reachable.js';
import { resolveRepositoryIdentity } from '../git/repository.js';
import { captureSnapshot } from '../git/snapshot.js';
import {
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
import { search as runSearch } from '../search/search.js';
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
async function loadEmbedder(options: { offline: boolean; onProgress: RunOptions['onProgress'] }): Promise<Embedder> {
  options.onProgress({ stage: 'model', message: 'loading embedding model' });
  return loadDefaultEmbedder({
    offline: options.offline,
    onProgress: (p) =>
      options.onProgress({
        stage: 'model',
        // Content-Length is optional, so a percentage is not always available.
        message:
          p.totalBytes === null
            ? `downloading ${p.file} (${p.bytesDownloaded} bytes)`
            : `downloading ${p.file} (${Math.round((p.bytesDownloaded / Math.max(p.totalBytes, 1)) * 100)}%)`,
      }),
  });
}

/** Any recorded omission means the corpus is partial for the current policy. */
function coverageSummaryOf(omissions: ManifestOmissionCounts): SnapshotSummary['coverage'] {
  const anyOmission =
    omissions.excludedFiles > 0 ||
    omissions.unavailableFiles > 0 ||
    omissions.failedFiles > 0 ||
    omissions.reasons.length > 0;
  return anyOmission ? 'partial' : 'complete_for_policy';
}

function toSnapshotSummary(
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
  try {
    const snapshot = await captureSnapshot(identity);
    fingerprint = snapshot.fingerprint;
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
  });
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
      const opened = await openReadOnlyStore(repo.identity, refreshOptions(options));
      try {
        const embedder = needsEmbedder ? await loadEmbedder(options) : null;
        const snapshot = await captureSnapshot(repo.identity);
        const fresh = snapshot.fingerprint === opened.manifest.snapshotFingerprint;
        const summary = toSnapshotSummary(
          snapshot,
          opened.generationId,
          opened.manifest.updatedAt,
          fresh ? 'current' : 'stale',
          coverageSummaryOf(opened.manifest.omissions),
        );
        return await runSearch(request, opened.store, embedder, summary);
      } finally {
        await opened.store.close();
        opened.lock.release();
      }
    }

    const { snapshot, reachable } = await captureReachable(repo);
    const deps = await storageDeps(options);
    const ensured = await ensureCurrentGeneration(
      repo.identity,
      snapshot,
      reachable,
      deps,
      refreshOptions(options),
    );

    const opened = await openReadOnlyStore(repo.identity, refreshOptions(options));
    try {
      const summary = toSnapshotSummary(
        snapshot,
        ensured.generationId,
        ensured.manifest.updatedAt,
        'current',
        coverageSummaryOf(ensured.manifest.omissions),
      );
      return await runSearch(request, opened.store, needsEmbedder ? deps.embedder : null, summary);
    } finally {
      await opened.store.close();
      opened.lock.release();
      await deps.embedder.dispose();
    }
  }

  async index(repo: RepositoryHandle, options: RunOptions): Promise<IndexStatus> {
    if (options.noRefresh) {
      throw new GitWhyError('INVALID_ARGUMENTS', '--no-refresh cannot be combined with `git why index`', {
        hint: 'Drop --no-refresh to build or reconcile the index.',
      });
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
      throw new GitWhyError('INVALID_ARGUMENTS', '--no-refresh cannot be combined with `git why rebuild`', {
        hint: 'Drop --no-refresh to rebuild the index.',
      });
    }
    const { snapshot, reachable } = await captureReachable(repo);
    const deps = await storageDeps(options);
    try {
      await rebuildGeneration(repo.identity, snapshot, reachable, deps, refreshOptions(options));
    } finally {
      await deps.embedder.dispose();
    }
    return statusOf(repo, options);
  }

  async gc(repo: RepositoryHandle, options: RunOptions): Promise<IndexStatus> {
    if (options.noRefresh) {
      throw new GitWhyError('INVALID_ARGUMENTS', '--no-refresh cannot be combined with `git why gc`', {
        hint: 'Drop --no-refresh to compact the index.',
      });
    }
    // gc reconciles without downloading embeddings, so no model is loaded here.
    options.onProgress({ stage: 'gc', message: 'removing abandoned generations' });
    await gcGenerations(repo.identity, refreshOptions(options));
    return statusOf(repo, options);
  }
}

export async function createBackend(): Promise<Backend> {
  const testBackendPath = process.env.GIT_WHY_TEST_BACKEND;
  if (testBackendPath) {
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
