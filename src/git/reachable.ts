/**
 * Enumerate the complete reachable commit set for a captured snapshot's tips.
 *
 * Tips are fed to `git rev-list --stdin` (never as argv, which has a length limit),
 * batched into chunks so no single invocation's stdin/stdout grows unbounded. A failed
 * or interrupted enumeration throws — it never returns an empty set to a caller that
 * would mistake that for "this repository has no history".
 */

import { GitWhyError, type RepositoryIdentity } from '../types.js';
import { runGit } from './exec.js';

const BATCH_SIZE = 4000;
/** Reachable-commit OIDs are small (one per line); generous but not unbounded. */
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Full ancestry closure of `tipOids` (already-resolved OIDs; this never re-resolves a
 * branch name). Uses plain `rev-list --stdin` (a real walk) per batch, deduplicating
 * across batches — the `--no-walk=unsorted` variant of this call is for a different
 * job (see `extract.ts`), where a caller already has an exact, known commit list and
 * wants Git to validate/stream it back without re-walking or re-sorting it.
 */
export async function enumerateReachable(
  repository: RepositoryIdentity,
  tipOids: readonly string[],
): Promise<string[]> {
  if (tipOids.length === 0) return [];

  const result = new Set<string>();
  for (const batch of chunk(tipOids, BATCH_SIZE)) {
    const input = Buffer.from(batch.join('\n') + '\n', 'utf8');
    const res = await runGit({
      gitDir: repository.commonDir,
      cwd: repository.commonDir,
      args: ['rev-list', '--stdin'],
      input,
      maxBytes: MAX_OUTPUT_BYTES,
    });
    if (res.code !== 0) {
      throw new GitWhyError(
        'EXTRACTION_FAILED',
        `git rev-list --stdin failed while enumerating reachable commits: ${res.stderr.toString('utf8').trim()}`,
      );
    }
    if (res.truncatedStdout) {
      throw new GitWhyError(
        'EXTRACTION_FAILED',
        'git rev-list --stdin output exceeded the memory cap while enumerating reachable commits',
      );
    }
    const text = res.stdout.toString('utf8');
    for (const line of text.split('\n')) {
      const oid = line.trim();
      if (oid.length > 0) result.add(oid);
    }
  }
  return [...result].sort();
}
