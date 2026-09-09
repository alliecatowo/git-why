/**
 * Read-only `IndexStatus` computation (spec section 12). Never downloads a
 * model, never repairs storage, never starts indexing — it only looks at
 * what is already on disk. Manifest reads are safe without a lock because
 * publication is atomic (temp file + rename); a concurrent writer either
 * has or hasn't published yet, never a half-written file.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { IndexStatus, ObjectFormat } from '../types.js';
import { layoutFor, generationPaths, readCurrentGenerationId } from './layout.js';
import { readManifest, manifestPolicyIsCompatible, type IndexManifest } from './manifest.js';
import { readPendingBatch } from './journal.js';

export interface ComputeStatusInput {
  readonly commonDir: string;
  readonly objectFormat: ObjectFormat;
  readonly shallow: boolean;
  /**
   * The freshly captured snapshot fingerprint, when the caller already paid
   * for a full tip enumeration. Pass `null` for a cheap ref-only check.
   */
  readonly currentSnapshotFingerprint: string | null;
  /** Whether a cheap ref comparison detected any tip movement since the manifest's recorded fingerprint. */
  readonly refsChanged: boolean;
}

function directorySizeBytes(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += directorySizeBytes(full);
    else if (entry.isFile()) {
      try {
        total += fs.statSync(full).size;
      } catch {
        // raced with a concurrent writer; skip
      }
    }
  }
  return total;
}

function missingStatus(input: ComputeStatusInput, indexPath: string): IndexStatus {
  return {
    state: 'missing',
    indexPath,
    generation: null,
    indexedCommits: null,
    reachableCommits: null,
    refsChanged: input.refsChanged,
    recordCount: null,
    model: null,
    diskBytes: null,
    indexedAt: null,
    objectFormat: input.objectFormat,
    shallow: input.shallow,
    coverage: { excludedFiles: 0, unavailableFiles: 0, failedFiles: 0, reasons: [] },
    warnings: [],
  };
}

export function computeIndexStatus(input: ComputeStatusInput): IndexStatus {
  const layout = layoutFor(input.commonDir);
  let generationId: string | null;
  try {
    generationId = readCurrentGenerationId(layout);
  } catch {
    return { ...missingStatus(input, layout.stateDir), state: 'rebuild_required', warnings: ['CURRENT file could not be read'] };
  }
  if (generationId === null) return missingStatus(input, layout.stateDir);

  const gp = generationPaths(layout, generationId);
  const warnings: string[] = [];

  let manifest: IndexManifest | null;
  try {
    manifest = readManifest(gp.manifestFile);
  } catch (err) {
    return {
      ...missingStatus(input, layout.stateDir),
      state: 'rebuild_required',
      generation: generationId,
      warnings: [`manifest is corrupt: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  if (manifest === null) {
    return { ...missingStatus(input, layout.stateDir), state: 'rebuild_required', generation: generationId, warnings: ['generation is published but has no manifest'] };
  }

  if (!manifestPolicyIsCompatible(manifest)) {
    warnings.push('manifest policy versions do not match this build; a rebuild is required');
  }

  let pendingRecovery = false;
  try {
    pendingRecovery = readPendingBatch(gp.pendingFile) !== null;
  } catch {
    pendingRecovery = true; // a corrupt pending marker still means recovery is required
  }

  const diskBytes = directorySizeBytes(gp.dir);

  let state: IndexStatus['state'];
  if (!manifestPolicyIsCompatible(manifest)) {
    state = 'rebuild_required';
  } else if (manifest.state === 'recovery_required' || pendingRecovery) {
    state = 'recovery_required';
  } else if (input.currentSnapshotFingerprint !== null) {
    state = input.currentSnapshotFingerprint === manifest.snapshotFingerprint ? 'current' : 'stale';
  } else if (input.refsChanged) {
    state = 'stale';
  } else {
    state = 'current';
  }

  if (!manifest.omissions.reasons.every((r) => typeof r === 'string')) {
    warnings.push('omission reasons list is malformed');
  }

  return {
    state,
    indexPath: layout.stateDir,
    generation: generationId,
    indexedCommits: manifest.counts.commits,
    reachableCommits: input.currentSnapshotFingerprint !== null ? null : null,
    refsChanged: input.refsChanged,
    recordCount: manifest.counts.commits + manifest.counts.evidence,
    model: { id: manifest.embeddingModelId, revision: manifest.embeddingModelRevision, fingerprint: manifest.embeddingFingerprint },
    diskBytes,
    indexedAt: manifest.updatedAt,
    objectFormat: manifest.objectFormat,
    shallow: input.shallow,
    coverage: {
      excludedFiles: manifest.omissions.excludedFiles,
      unavailableFiles: manifest.omissions.unavailableFiles,
      failedFiles: manifest.omissions.failedFiles,
      reasons: manifest.omissions.reasons,
    },
    warnings,
  };
}
