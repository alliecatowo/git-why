/**
 * Choose up to two nonredundant evidence excerpts per winning commit.
 *
 * Only evidence that actually matched a branch query is ever attached: a
 * summary-only result is valid, and we never fetch arbitrary hunks via
 * `HistoryStore.evidenceForCommit` just to make a result look
 * substantive. "Nonredundant" means not two slices of the same hunk (or
 * two copies of the same file_change metadata record); diversity across
 * paths/hunks is preferred over raw score, since lexical and semantic
 * branch scores are not comparable to each other (spec section 14).
 */
import type { EvidenceHit, EvidenceRecord, HistoryStore, ScoredRecord } from '../types.js';

function evidenceGroupKey(rec: EvidenceRecord): string {
  return `${rec.path.display}#${rec.hunkOrdinal ?? 'file_change'}`;
}

export async function chooseEvidence(
  lexicalRecords: readonly ScoredRecord[],
  semanticRecords: readonly ScoredRecord[],
  store: HistoryStore,
  maxCount = 2,
): Promise<EvidenceHit[]> {
  const lex = lexicalRecords.filter((r) => r.type === 'evidence').sort((a, b) => b.score - a.score);
  const sem = semanticRecords
    .filter((r) => r.type === 'evidence')
    .sort((a, b) => b.score - a.score);

  // Interleave the two branches (best-first within each) rather than
  // sorting by raw score across branches, since those scores are not on a
  // comparable scale.
  const orderedIds: string[] = [];
  const seenIds = new Set<string>();
  const maxLen = Math.max(lex.length, sem.length);
  for (let i = 0; i < maxLen; i += 1) {
    const l = lex[i];
    if (l !== undefined && !seenIds.has(l.id)) {
      orderedIds.push(l.id);
      seenIds.add(l.id);
    }
    const s = sem[i];
    if (s !== undefined && !seenIds.has(s.id)) {
      orderedIds.push(s.id);
      seenIds.add(s.id);
    }
  }

  if (orderedIds.length === 0) return [];

  const fetched = await store.fetchEvidence(orderedIds);

  const chosen: EvidenceRecord[] = [];
  const seenGroups = new Set<string>();
  for (const id of orderedIds) {
    const rec = fetched.get(id);
    if (rec === undefined) continue;
    const key = evidenceGroupKey(rec);
    if (seenGroups.has(key)) continue;
    seenGroups.add(key);
    chosen.push(rec);
    if (chosen.length >= maxCount) break;
  }

  return chosen.map((rec) => ({
    recordId: rec.id,
    kind: rec.kind,
    path: rec.path,
    oldPath: rec.oldPath,
    changeType: rec.changeType,
    oldStart: rec.oldStart,
    oldCount: rec.oldCount,
    newStart: rec.newStart,
    newCount: rec.newCount,
    excerpt: rec.sourceExcerpt,
    truncated: rec.coverage.truncated,
    omissionReasons: rec.coverage.reasons,
  }));
}
