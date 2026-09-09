/**
 * Application durability journal (spec section 12, "Application
 * durability"). Zvec's own write path does not atomically update a
 * separate manifest, so pending intent is recorded durably before a batch
 * is applied, and only cleared after the catalog checkpoint and manifest
 * are published. See docs/decisions.md section 7 for what was actually
 * verified about the underlying collection's durability (per-record
 * `upsertSync` results, not an invented `flush()`).
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ZVecCollection, ZVecDocInput, ZVecStatus } from '@zvec/zvec';
import { GitWhyError } from '../types.js';
import { fsyncDirectoryBestEffort } from './layout.js';

export interface PendingBatch {
  readonly version: 1;
  readonly generationId: string;
  readonly startedAt: string;
  /** Commit SHAs whose evidence/summary records were being (re)written when this was last durably recorded. */
  readonly commitShas: readonly string[];
}

export function readPendingBatch(pendingFile: string): PendingBatch | null {
  let raw: string;
  try {
    raw = fs.readFileSync(pendingFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new GitWhyError(
      'STORAGE_FAILED',
      `failed to read pending marker at ${pendingFile}: ${(err as Error).message}`,
      { cause: err },
    );
  }
  try {
    const parsed = JSON.parse(raw) as PendingBatch;
    if (parsed.version !== 1 || !Array.isArray(parsed.commitShas)) {
      throw new Error('unexpected shape');
    }
    return parsed;
  } catch (err) {
    // A corrupt pending marker still means "recovery required" — treat it
    // as a full-generation replay signal rather than silently ignoring it.
    throw new GitWhyError(
      'INDEX_RECOVERY_REQUIRED',
      `pending marker at ${pendingFile} is corrupt and requires recovery`,
      { cause: err },
    );
  }
}

/** Step 1 of application durability: record intent BEFORE applying anything. */
export function writePendingBatch(pendingFile: string, batch: PendingBatch): void {
  const dir = path.dirname(pendingFile);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.pending.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(batch));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, pendingFile);
  fsyncDirectoryBestEffort(dir);
}

/** Last step of a successful reconciliation, called ONLY after the catalog checkpoint and manifest are published. */
export function clearPendingBatch(pendingFile: string): void {
  try {
    fs.unlinkSync(pendingFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new GitWhyError(
        'STORAGE_FAILED',
        `failed to clear pending marker at ${pendingFile}: ${(err as Error).message}`,
        { cause: err },
      );
    }
  }
  fsyncDirectoryBestEffort(path.dirname(pendingFile));
}

/** One commit's complete set of durable writes, applied as a unit. */
export interface CommitBatchUnit {
  readonly commitSha: string;
  /** Doc ids to remove before reinsert (idempotent replace of a previously-partial or now-stale commit/evidence set). Deterministic ids make this safe to repeat. */
  readonly staleIds: readonly string[];
  /** The commit doc plus its evidence docs, applied together. */
  readonly upserts: readonly ZVecDocInput[];
}

export interface ApplyBatchResult {
  readonly appliedShas: readonly string[];
  readonly failedShas: readonly { readonly sha: string; readonly reason: string }[];
}

function statusesOf(result: ZVecStatus | ZVecStatus[]): ZVecStatus[] {
  return Array.isArray(result) ? result : [result];
}

/**
 * Apply a batch of per-commit units, verifying each record's individual
 * outcome (including APIs that return partial-failure arrays). The pending
 * marker for this batch must already have been written by the caller via
 * `writePendingBatch` before this runs; this function does not clear it —
 * the caller clears it only after the catalog/manifest checkpoint that
 * follows a successful apply.
 */
export function applyCommitBatch(
  collection: ZVecCollection,
  units: readonly CommitBatchUnit[],
): ApplyBatchResult {
  const appliedShas: string[] = [];
  const failedShas: { sha: string; reason: string }[] = [];

  for (const unit of units) {
    try {
      if (unit.staleIds.length > 0) {
        // Deleting an id that no longer exists is not an error; only a thrown exception is.
        if (unit.staleIds.length === 1) collection.deleteSync(unit.staleIds[0]!);
        else collection.deleteSync([...unit.staleIds]);
      }
      if (unit.upserts.length === 0) {
        appliedShas.push(unit.commitSha);
        continue;
      }
      const result =
        unit.upserts.length === 1
          ? collection.upsertSync(unit.upserts[0]!)
          : collection.upsertSync([...unit.upserts]);
      const statuses = statusesOf(result);
      const failed = statuses.filter((s) => !s.ok);
      if (failed.length > 0) {
        failedShas.push({
          sha: unit.commitSha,
          reason: failed.map((f) => `${f.code}: ${f.message}`).join('; '),
        });
        continue;
      }
      appliedShas.push(unit.commitSha);
    } catch (err) {
      failedShas.push({
        sha: unit.commitSha,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { appliedShas, failedShas };
}
