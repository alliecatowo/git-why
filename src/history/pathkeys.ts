/**
 * Path match keys: what the storage adapter indexes to answer "does this
 * record touch path X (or a descendant of directory X)".
 *
 * A file's keys are its complete normalised path plus every directory
 * prefix. A commit summary's keys cover every one of its changed paths
 * (old and new). A hunk's keys cover *only its own* old and new path --
 * never the commit's other changed paths. That asymmetry is what lets
 * `-- src/auth/session.ts` select the one hunk that touches that file
 * instead of every hunk in a commit that happens to also touch it.
 */
import type { HistoricalPath, HistoricalPathChange } from '../types.js';

/** Normalised path -> itself plus every directory prefix, shortest first, full path last. */
export function pathMatchKeys(normalizedPath: string): string[] {
  const parts = normalizedPath.split('/').filter((p) => p.length > 0);
  const keys: string[] = [];
  let prefix = '';
  for (const part of parts) {
    prefix = prefix.length === 0 ? part : `${prefix}/${part}`;
    keys.push(prefix);
  }
  return keys;
}

function addPathKeys(target: Set<string>, path: HistoricalPath | null): void {
  if (path === null) return;
  for (const key of pathMatchKeys(path.display)) target.add(key);
}

/** Match keys for a commit-summary record: the union over every changed path (old and new). */
export function commitSummaryPathKeys(changedPaths: readonly HistoricalPathChange[]): string[] {
  const set = new Set<string>();
  for (const change of changedPaths) {
    addPathKeys(set, change.path);
    addPathKeys(set, change.oldPath);
  }
  return [...set].sort();
}

/** Match keys for one hunk/evidence record: only its own old and new path. */
export function hunkPathKeys(path: HistoricalPath, oldPath: HistoricalPath | null): string[] {
  const set = new Set<string>();
  addPathKeys(set, path);
  addPathKeys(set, oldPath);
  return [...set].sort();
}
