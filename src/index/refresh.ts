/**
 * Incremental refresh, rebuild, and gc (spec section 12). The numbered
 * steps below are the spec's algorithm; storage owns steps 2-3 and 5-9,
 * and receives the results of steps 1 and 4 (snapshot capture and
 * reachable-set enumeration) as input, because both are Git-lane
 * concerns and this module must not import `src/git/`.
 *
 * Dependencies come in ONLY as the `HistoryExtractor` and `Embedder`
 * interfaces from `src/types.ts`, exactly as required.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  CommitExtraction,
  Embedder,
  HistoryExtractor,
  ObjectFormat,
  OmissionReason,
  RepositorySnapshot,
} from '../types.js';
import { GitWhyError } from '../types.js';
import {
  layoutFor,
  ensureScaffolding,
  generationPaths,
  stagingPaths,
  readCurrentGenerationId,
  publishCurrentGenerationId,
  recursivelyRemove,
  assertSafeToRecursivelyDelete,
  type GenerationPaths,
} from './layout.js';
import {
  acquireExclusive,
  acquireShared,
  type LockHandle,
  DEFAULT_LOCK_TIMEOUT_SECONDS,
} from './lock.js';
import {
  readManifest,
  writeManifestAtomic,
  manifestPolicyIsCompatible,
  currentPolicyIdentities,
  type IndexManifest,
} from './manifest.js';
import {
  readPendingBatch,
  writePendingBatch,
  clearPendingBatch,
  applyCommitBatch,
  type CommitBatchUnit,
} from './journal.js';
import {
  openOrCreateHistoryCollection,
  buildCommitDoc,
  buildEvidenceDoc,
  ZvecHistoryStore,
  DATABASE_FORMAT_COMPATIBILITY,
  type VectorIndexKind,
} from './collection.js';
import { ZVecOpen, isZVecError } from '@zvec/zvec';
import type { ZVecCollection } from '@zvec/zvec';

/**
 * The complete reachable commit SHA set for a snapshot's tips (spec step
 * 4). Enumeration itself (`git rev-list --stdin` or equivalent) is a
 * Git-lane concern; storage only ever consumes the result. `complete` must
 * be false whenever enumeration failed or was interrupted, so a failed
 * enumeration can never be mistaken for an empty reachable set and used to
 * prune the index (spec section 12).
 */
export interface ReachableSet {
  readonly shas: readonly string[];
  readonly complete: boolean;
}

export interface StorageDeps {
  readonly extractor: HistoryExtractor;
  readonly embedder: Embedder;
}

export interface RefreshOptions {
  readonly lockTimeoutSeconds?: number;
  readonly noRefresh?: boolean;
  /** Force retrying incomplete records even when the repository view hasn't changed. */
  readonly forceRetryIncomplete?: boolean;
  readonly batchSize?: number;
  readonly vectorIndex?: VectorIndexKind;
}

export interface EnsureResult {
  readonly generationId: string;
  readonly manifest: IndexManifest;
}

interface CatalogEntry {
  readonly id: string;
  readonly evidenceIds: readonly string[];
  readonly complete: boolean;
  readonly updatedAt: string;
}

function readCatalog(commitsFile: string): Map<string, CatalogEntry> {
  const map = new Map<string, CatalogEntry>();
  let raw: string;
  try {
    raw = fs.readFileSync(commitsFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return map;
    throw new GitWhyError(
      'STORAGE_FAILED',
      `failed to read commit catalog at ${commitsFile}: ${(err as Error).message}`,
      { cause: err },
    );
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as { sha: string } & CatalogEntry;
      map.set(parsed.sha, {
        id: parsed.id,
        evidenceIds: parsed.evidenceIds,
        complete: parsed.complete,
        updatedAt: parsed.updatedAt,
      });
    } catch {
      // A malformed catalog line means recovery is required, not a crash of status/refresh.
      throw new GitWhyError(
        'INDEX_RECOVERY_REQUIRED',
        `commit catalog at ${commitsFile} contains a malformed line`,
      );
    }
  }
  return map;
}

function writeCatalogAtomic(commitsFile: string, catalog: ReadonlyMap<string, CatalogEntry>): void {
  const dir = path.dirname(commitsFile);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [...catalog.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([sha, entry]) => JSON.stringify({ sha, ...entry }));
  const tmp = path.join(
    dir,
    `.commits.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, lines.length > 0 ? lines.join('\n') + '\n' : '');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, commitsFile);
}

function newGenerationId(): string {
  return `g-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function emptyManifest(
  generationId: string,
  objectFormat: ObjectFormat,
  embedder: Embedder,
): IndexManifest {
  const now = new Date().toISOString();
  return {
    ...currentPolicyIdentities(),
    embeddingModelId: embedder.modelId,
    embeddingModelRevision: embedder.revision,
    embeddingFingerprint: embedder.fingerprint,
    objectFormat,
    snapshotFingerprint: '',
    databaseFormatCompatibility: DATABASE_FORMAT_COMPATIBILITY,
    counts: { commits: 0, evidence: 0 },
    omissions: { excludedFiles: 0, unavailableFiles: 0, failedFiles: 0, reasons: [] },
    createdAt: now,
    updatedAt: now,
    state: 'clean',
    generationId,
  };
}

function isViewChanged(manifest: IndexManifest | null, snapshot: RepositorySnapshot): boolean {
  return manifest === null || manifest.snapshotFingerprint !== snapshot.fingerprint;
}

/** True when the quick, lock-cheap "is the current generation already good enough" check passes. */
function isAlreadyCurrent(
  manifest: IndexManifest | null,
  hasPending: boolean,
  snapshot: RepositorySnapshot,
): boolean {
  if (manifest === null) return false;
  if (hasPending) return false;
  if (manifest.state !== 'clean') return false;
  if (!manifestPolicyIsCompatible(manifest)) return false;
  return manifest.snapshotFingerprint === snapshot.fingerprint;
}

async function collectExtractions(
  extractor: HistoryExtractor,
  snapshot: RepositorySnapshot,
  shas: readonly string[],
): Promise<CommitExtraction[]> {
  const out: CommitExtraction[] = [];
  for await (const extraction of extractor.extract(snapshot, shas)) {
    out.push(extraction);
  }
  return out;
}

interface BatchOutcome {
  readonly appliedShas: readonly string[];
  readonly failedShas: readonly { sha: string; reason: string }[];
  readonly excludedFiles: number;
  readonly unavailableFiles: number;
  readonly failedFiles: number;
  readonly reasons: Set<OmissionReason>;
}

async function applyBatch(
  collection: ZVecCollection,
  pendingFile: string,
  generationId: string,
  extractor: HistoryExtractor,
  embedder: Embedder,
  snapshot: RepositorySnapshot,
  batchShas: readonly string[],
  catalog: Map<string, CatalogEntry>,
): Promise<BatchOutcome> {
  writePendingBatch(pendingFile, {
    version: 1,
    generationId,
    startedAt: new Date().toISOString(),
    commitShas: [...batchShas],
  });

  const extractions = await collectExtractions(extractor, snapshot, batchShas);

  const texts: string[] = [];
  for (const extraction of extractions) {
    texts.push(extraction.commit.semanticText);
    for (const evidence of extraction.evidence) texts.push(evidence.semanticText);
  }
  const vectors = texts.length > 0 ? await embedder.embedDocuments(texts) : [];

  let cursor = 0;
  const units: CommitBatchUnit[] = [];
  const commitVectorBySha = new Map<
    string,
    { commitVector: Float32Array; evidenceVectors: Float32Array[] }
  >();
  for (const extraction of extractions) {
    const commitVector = vectors[cursor]!;
    cursor++;
    const evidenceVectors: Float32Array[] = [];
    for (let i = 0; i < extraction.evidence.length; i++) {
      evidenceVectors.push(vectors[cursor]!);
      cursor++;
    }
    commitVectorBySha.set(extraction.commit.sha, { commitVector, evidenceVectors });

    const previous = catalog.get(extraction.commit.sha);
    const staleIds = previous !== undefined ? [previous.id, ...previous.evidenceIds] : [];

    const upserts = [
      buildCommitDoc({ record: extraction.commit, vector: commitVector }),
      ...extraction.evidence.map((evidence, i) =>
        buildEvidenceDoc({
          record: evidence,
          vector: evidenceVectors[i]!,
          committerTime: extraction.commit.committerTime,
          author: extraction.commit.author,
        }),
      ),
    ];
    units.push({ commitSha: extraction.commit.sha, staleIds, upserts });
  }

  const result = applyCommitBatch(collection, units);

  const reasons = new Set<OmissionReason>();
  let excludedFiles = 0;
  let unavailableFiles = 0;
  let failedFiles = 0;
  const appliedSet = new Set(result.appliedShas);
  for (const extraction of extractions) {
    if (!appliedSet.has(extraction.commit.sha)) continue;
    const coverages = [extraction.commit.coverage, ...extraction.evidence.map((e) => e.coverage)];
    const complete = coverages.every((c) => c.complete);
    for (const c of coverages) {
      excludedFiles += c.excludedFiles;
      unavailableFiles += c.unavailableFiles;
      failedFiles += c.failedFiles;
      for (const r of c.reasons) reasons.add(r);
    }
    catalog.set(extraction.commit.sha, {
      id: extraction.commit.id,
      evidenceIds: extraction.evidence.map((e) => e.id),
      complete,
      updatedAt: new Date().toISOString(),
    });
  }

  return {
    appliedShas: result.appliedShas,
    failedShas: result.failedShas,
    excludedFiles,
    unavailableFiles,
    failedFiles,
    reasons,
  };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Reconcile one generation's collection against `reachable` (spec steps
 * 4-9), checkpointing after every bounded batch so an interruption resumes
 * cheaply instead of restarting. Shared by incremental refresh and
 * rebuild; the caller decides whether `paths` points at the active
 * generation or a fresh staging one.
 */
async function reconcile(
  paths: GenerationPaths,
  objectFormat: ObjectFormat,
  snapshot: RepositorySnapshot,
  reachable: ReachableSet,
  deps: StorageDeps,
  options: Required<Pick<RefreshOptions, 'forceRetryIncomplete' | 'batchSize' | 'vectorIndex'>>,
): Promise<IndexManifest> {
  fs.mkdirSync(paths.dir, { recursive: true });
  let manifest =
    readManifest(paths.manifestFile) ?? emptyManifest(paths.id, objectFormat, deps.embedder);
  const viewChanged = isViewChanged(manifest, snapshot);

  const catalog = readCatalog(paths.commitsFile);
  const pending = readPendingBatch(paths.pendingFile);

  const reachableSet = new Set(reachable.shas);
  const newShas = reachable.shas.filter((sha) => !catalog.has(sha));
  const retryShas = [...catalog.entries()]
    .filter(
      ([sha, entry]) =>
        reachableSet.has(sha) && !entry.complete && (options.forceRetryIncomplete || viewChanged),
    )
    .map(([sha]) => sha);
  const recoveryShas =
    pending !== null ? pending.commitShas.filter((sha) => reachableSet.has(sha)) : [];

  const toProcess = [...new Set([...recoveryShas, ...newShas, ...retryShas])];

  const collection = openOrCreateHistoryCollection(paths.collectionDir, {
    embeddingDimension: deps.embedder.dimension,
    vectorIndex: options.vectorIndex,
  });
  try {
    const omissionReasons = new Set<OmissionReason>();
    let excludedFiles = 0;
    let unavailableFiles = 0;
    let failedFiles = 0;

    for (const batch of chunk(toProcess, options.batchSize)) {
      const outcome = await applyBatch(
        collection,
        paths.pendingFile,
        paths.id,
        deps.extractor,
        deps.embedder,
        snapshot,
        batch,
        catalog,
      );
      excludedFiles += outcome.excludedFiles;
      unavailableFiles += outcome.unavailableFiles;
      failedFiles += outcome.failedFiles;
      for (const r of outcome.reasons) omissionReasons.add(r);

      writeCatalogAtomic(paths.commitsFile, catalog);
      manifest = {
        ...manifest,
        ...currentPolicyIdentities(),
        embeddingModelId: deps.embedder.modelId,
        embeddingModelRevision: deps.embedder.revision,
        embeddingFingerprint: deps.embedder.fingerprint,
        objectFormat,
        databaseFormatCompatibility: DATABASE_FORMAT_COMPATIBILITY,
        counts: countsOf(catalog),
        omissions: { excludedFiles, unavailableFiles, failedFiles, reasons: [...omissionReasons] },
        updatedAt: new Date().toISOString(),
        state: outcome.failedShas.length > 0 ? 'recovery_required' : 'clean',
        generationId: paths.id,
      };
      writeManifestAtomic(paths.manifestFile, manifest);
      clearPendingBatch(paths.pendingFile);

      if (outcome.failedShas.length > 0) {
        // Bounded batches are independent; stop here rather than compound
        // failures, and leave a clean, resumable checkpoint behind.
        throw new GitWhyError(
          'EXTRACTION_FAILED',
          `${outcome.failedShas.length} commit(s) failed extraction/embedding in this batch: ${outcome.failedShas
            .slice(0, 3)
            .map((f) => f.sha)
            .join(', ')}${outcome.failedShas.length > 3 ? ', ...' : ''}`,
        );
      }
    }

    // Prune now-ineligible commits, but ONLY when the reachable set and the
    // snapshot itself are both known-complete — an interrupted enumeration
    // must never be read as "nothing is reachable" and used to delete.
    if (reachable.complete && snapshot.complete) {
      const ineligible = [...catalog.keys()].filter((sha) => !reachableSet.has(sha));
      if (ineligible.length > 0) {
        const idsToDelete = ineligible.flatMap((sha) => {
          const entry = catalog.get(sha)!;
          return [entry.id, ...entry.evidenceIds];
        });
        if (idsToDelete.length > 0) collection.deleteSync(idsToDelete);
        for (const sha of ineligible) catalog.delete(sha);
        writeCatalogAtomic(paths.commitsFile, catalog);
      }
    }

    manifest = {
      ...manifest,
      snapshotFingerprint: snapshot.fingerprint,
      counts: countsOf(catalog),
      updatedAt: new Date().toISOString(),
      state: 'clean',
    };
    writeManifestAtomic(paths.manifestFile, manifest);
    clearPendingBatch(paths.pendingFile);
    return manifest;
  } finally {
    collection.closeSync();
  }
}

function countsOf(catalog: ReadonlyMap<string, CatalogEntry>): {
  commits: number;
  evidence: number;
} {
  let evidence = 0;
  for (const entry of catalog.values()) evidence += entry.evidenceIds.length;
  return { commits: catalog.size, evidence };
}

/**
 * The incremental refresh entry point (spec section 12, steps 2-9 with
 * steps 1 and 4 supplied by the caller). Acquires exclusive access only
 * when work is actually needed; releases it before returning.
 */
export async function ensureCurrentGeneration(
  repository: { readonly commonDir: string; readonly objectFormat: ObjectFormat },
  snapshot: RepositorySnapshot,
  reachable: ReachableSet,
  deps: StorageDeps,
  options: RefreshOptions = {},
): Promise<EnsureResult> {
  const layout = layoutFor(repository.commonDir);
  ensureScaffolding(layout);
  const lockTimeoutSeconds = options.lockTimeoutSeconds ?? DEFAULT_LOCK_TIMEOUT_SECONDS;

  // Step 2: cheap check under a shared lock.
  const quick = await acquireShared(layout.repositoryLockFile, lockTimeoutSeconds);
  try {
    const generationId = readCurrentGenerationId(layout);
    if (generationId !== null) {
      const paths = generationPaths(layout, generationId);
      const manifest = readManifest(paths.manifestFile);
      const pending = manifest === null ? null : readPendingBatch(paths.pendingFile);
      if (isAlreadyCurrent(manifest, pending !== null, snapshot)) {
        return { generationId, manifest: manifest! };
      }
    }
  } finally {
    quick.release();
  }

  if (options.noRefresh === true) {
    throw new GitWhyError(
      'INDEX_RECOVERY_REQUIRED',
      'the index needs reconciliation but --no-refresh was passed',
    );
  }

  // Step 3: exclusive access, then recheck — another process may have finished.
  const exclusive = await acquireExclusive(layout.repositoryLockFile, lockTimeoutSeconds);
  try {
    let generationId = readCurrentGenerationId(layout);
    let paths: GenerationPaths;
    if (generationId !== null) {
      paths = generationPaths(layout, generationId);
      const manifest = readManifest(paths.manifestFile);
      const pending = manifest === null ? null : readPendingBatch(paths.pendingFile);
      if (isAlreadyCurrent(manifest, pending !== null, snapshot)) {
        return { generationId, manifest: manifest! };
      }
    } else {
      generationId = newGenerationId();
      paths = generationPaths(layout, generationId);
    }

    const manifest = await reconcile(paths, repository.objectFormat, snapshot, reachable, deps, {
      forceRetryIncomplete: options.forceRetryIncomplete ?? false,
      batchSize: options.batchSize ?? 32,
      vectorIndex: options.vectorIndex ?? 'flat',
    });

    if (readCurrentGenerationId(layout) !== generationId) {
      publishCurrentGenerationId(layout, generationId);
    }
    return { generationId, manifest };
  } finally {
    exclusive.release();
  }
}

/**
 * Full rebuild: builds a brand-new generation in `staging/`, validates it,
 * closes all handles, moves it into `generations/`, and atomically
 * publishes `CURRENT` — only then is the previous generation eligible for
 * removal (by `gc`). A failed rebuild leaves the previous generation
 * untouched and usable.
 */
export async function rebuild(
  repository: { readonly commonDir: string; readonly objectFormat: ObjectFormat },
  snapshot: RepositorySnapshot,
  reachable: ReachableSet,
  deps: StorageDeps,
  options: RefreshOptions = {},
): Promise<EnsureResult> {
  const layout = layoutFor(repository.commonDir);
  ensureScaffolding(layout);
  const lockTimeoutSeconds = options.lockTimeoutSeconds ?? DEFAULT_LOCK_TIMEOUT_SECONDS;

  const exclusive = await acquireExclusive(layout.repositoryLockFile, lockTimeoutSeconds);
  try {
    const stagingId = newGenerationId();
    const staging = stagingPaths(layout, stagingId);
    try {
      const manifest = await reconcile(
        staging,
        repository.objectFormat,
        snapshot,
        reachable,
        deps,
        {
          forceRetryIncomplete: true,
          batchSize: options.batchSize ?? 32,
          vectorIndex: options.vectorIndex ?? 'flat',
        },
      );

      // Validate: the manifest must be clean and the collection must open.
      if (manifest.state !== 'clean') {
        throw new GitWhyError('STORAGE_FAILED', 'rebuild produced a non-clean generation');
      }
      const validation = openOrCreateHistoryCollection(
        staging.collectionDir,
        { embeddingDimension: deps.embedder.dimension },
        { readOnly: true },
      );
      validation.closeSync();

      const finalPaths = generationPaths(layout, stagingId);
      fs.mkdirSync(layout.generationsDir, { recursive: true });
      fs.renameSync(staging.dir, finalPaths.dir);
      publishCurrentGenerationId(layout, stagingId);
      return { generationId: stagingId, manifest };
    } catch (err) {
      // Never delete the only working index: only ever clean up the
      // staging attempt, which CURRENT never pointed at.
      try {
        assertSafeToRecursivelyDelete(layout, staging.dir);
        recursivelyRemove(layout, staging.dir);
      } catch {
        // best-effort cleanup; the original error is what matters
      }
      throw err;
    }
  } finally {
    exclusive.release();
  }
}

/**
 * Deferred compaction: removes staging leftovers and superseded
 * generations. Requires exclusive access. Never touches Git refs or
 * objects.
 */
export async function gc(
  repository: { readonly commonDir: string },
  options: { readonly lockTimeoutSeconds?: number } = {},
): Promise<{ removed: string[] }> {
  const layout = layoutFor(repository.commonDir);
  ensureScaffolding(layout);
  const exclusive = await acquireExclusive(
    layout.repositoryLockFile,
    options.lockTimeoutSeconds ?? DEFAULT_LOCK_TIMEOUT_SECONDS,
  );
  const removed: string[] = [];
  try {
    const currentId = readCurrentGenerationId(layout);
    for (const entry of listDirSafe(layout.generationsDir)) {
      if (entry === currentId) continue;
      const dir = path.join(layout.generationsDir, entry);
      assertSafeToRecursivelyDelete(layout, dir);
      recursivelyRemove(layout, dir);
      removed.push(dir);
    }
    for (const entry of listDirSafe(layout.stagingRootDir)) {
      const dir = path.join(layout.stagingRootDir, entry);
      assertSafeToRecursivelyDelete(layout, dir);
      recursivelyRemove(layout, dir);
      removed.push(dir);
    }
  } finally {
    exclusive.release();
  }
  return { removed };
}

function listDirSafe(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Open the currently-published generation for querying, holding a shared
 * lock the caller must release (via the returned handle) after the
 * collection is closed — do not hold it while rendering output.
 */
export async function openReadOnlyStore(
  repository: { readonly commonDir: string },
  options: { readonly lockTimeoutSeconds?: number } = {},
): Promise<{
  store: ZvecHistoryStore;
  generationId: string;
  manifest: IndexManifest;
  lock: LockHandle;
}> {
  const layout = layoutFor(repository.commonDir);
  const lock = await acquireShared(
    layout.repositoryLockFile,
    options.lockTimeoutSeconds ?? DEFAULT_LOCK_TIMEOUT_SECONDS,
  );
  try {
    const generationId = readCurrentGenerationId(layout);
    if (generationId === null) {
      throw new GitWhyError('INDEX_MISSING', 'no index has been built for this repository yet');
    }
    const paths = generationPaths(layout, generationId);
    const manifest = readManifest(paths.manifestFile);
    if (manifest === null) {
      throw new GitWhyError(
        'INDEX_CORRUPT',
        `generation ${generationId} is published but has no manifest`,
      );
    }
    if (manifest.state === 'recovery_required' || readPendingBatch(paths.pendingFile) !== null) {
      throw new GitWhyError(
        'INDEX_RECOVERY_REQUIRED',
        `generation ${generationId} requires recovery before it can be queried`,
      );
    }
    let collection: ZVecCollection;
    try {
      collection = ZVecOpen(paths.collectionDir, { readOnly: true });
    } catch (err) {
      throw new GitWhyError(
        'INDEX_CORRUPT',
        `failed to open collection for generation ${generationId}: ${isZVecError(err) ? err.message : String(err)}`,
        { cause: err },
      );
    }
    return { store: new ZvecHistoryStore(collection), generationId, manifest, lock };
  } catch (err) {
    lock.release();
    throw err;
  }
}

/**
 * Exposed for integration tests only (test/integration/index/refresh.test.ts).
 * `reconcile` lets a test build a generation's collection/manifest/catalog
 * WITHOUT publishing `CURRENT`, to directly exercise the "generation built
 * but never published" and "staging built but rebuild never switched over"
 * recovery paths without racing a real process kill against a step that
 * has no other externally-observable boundary. Do not import from
 * production code.
 */
export const __testHooks = { reconcile, newGenerationId };
