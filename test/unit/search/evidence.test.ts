import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseEvidence } from '../../../src/search/evidence.js';
import {
  EMPTY_COVERAGE,
  type EvidenceRecord,
  type HistoricalPath,
  type HistoryStore,
  type ScoredRecord,
} from '../../../src/types.js';

function hp(display: string): HistoricalPath {
  return { bytesBase64: Buffer.from(display).toString('base64'), display, lossy: false };
}

function evidence(
  id: string,
  path: string,
  hunkOrdinal: number | null,
  sliceOrdinal = 0,
): EvidenceRecord {
  return {
    type: 'evidence',
    kind: hunkOrdinal === null ? 'file_change' : 'hunk',
    id,
    sha: 'sha1',
    parentSha: null,
    path: hp(path),
    oldPath: null,
    changeType: 'M',
    hunkOrdinal,
    sliceOrdinal,
    header: null,
    oldStart: 1,
    oldCount: 1,
    newStart: 1,
    newCount: 1,
    sourceExcerpt: `excerpt for ${id}`,
    semanticText: '',
    lexicalText: '',
    coverage: EMPTY_COVERAGE,
  };
}

function fakeStore(records: readonly EvidenceRecord[]): Pick<HistoryStore, 'fetchEvidence'> {
  return {
    async fetchEvidence(ids: readonly string[]) {
      const map = new Map<string, EvidenceRecord>();
      for (const id of ids) {
        const rec = records.find((r) => r.id === id);
        if (rec) map.set(id, rec);
      }
      return map;
    },
  };
}

test('a commit with no matched evidence records gets a summary-only result (empty array)', async () => {
  const store = fakeStore([]);
  const result = await chooseEvidence([], [], store as HistoryStore);
  assert.deepEqual(result, []);
});

test('commit-type scored records are never treated as evidence candidates', async () => {
  const lex: ScoredRecord[] = [{ id: 'commit-1', type: 'commit', sha: 'sha1', score: 10 }];
  const store = fakeStore([]);
  const result = await chooseEvidence(lex, [], store as HistoryStore);
  assert.deepEqual(result, []);
});

test('at most two nonredundant excerpts are chosen, deduplicated by path+hunk', async () => {
  const records = [
    evidence('e1', 'src/a.ts', 0),
    evidence('e2', 'src/a.ts', 0, 1), // same path+hunk as e1 -- a different slice of the SAME hunk
    evidence('e3', 'src/b.ts', 0),
  ];
  const lex: ScoredRecord[] = [
    { id: 'e1', type: 'evidence', sha: 'sha1', score: 10 },
    { id: 'e2', type: 'evidence', sha: 'sha1', score: 9 },
    { id: 'e3', type: 'evidence', sha: 'sha1', score: 8 },
  ];
  const store = fakeStore(records);
  const result = await chooseEvidence(lex, [], store as HistoryStore, 2);
  assert.equal(result.length, 2);
  const ids = result.map((r) => r.recordId);
  assert.ok(ids.includes('e1')); // best-scored of the duplicate-group wins
  assert.ok(ids.includes('e3'));
  assert.ok(!ids.includes('e2'));
});

test('evidence never invents an unrelated hunk: only ids that actually matched are ever considered', async () => {
  const records = [evidence('e1', 'src/a.ts', 0), evidence('unmatched', 'src/z.ts', 0)];
  const lex: ScoredRecord[] = [{ id: 'e1', type: 'evidence', sha: 'sha1', score: 10 }];
  const store = fakeStore(records);
  const result = await chooseEvidence(lex, [], store as HistoryStore);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.recordId, 'e1');
});

test('lexical and semantic branches are interleaved rather than cross-branch-score-sorted', async () => {
  const records = [evidence('lex-hi', 'a.ts', 0), evidence('sem-hi', 'b.ts', 0)];
  // Lexical score is on a totally different (huge) scale than semantic;
  // interleaving must not let raw magnitude dominate branch representation.
  const lex: ScoredRecord[] = [{ id: 'lex-hi', type: 'evidence', sha: 'sha1', score: 1_000_000 }];
  const sem: ScoredRecord[] = [{ id: 'sem-hi', type: 'evidence', sha: 'sha1', score: 0.5 }];
  const store = fakeStore(records);
  const result = await chooseEvidence(lex, sem, store as HistoryStore, 2);
  const ids = result.map((r) => r.recordId).sort();
  assert.deepEqual(ids, ['lex-hi', 'sem-hi']);
});

test('excerpt field carries the faithful sourceExcerpt, and coverage/truncation propagate', async () => {
  const rec = evidence('e1', 'a.ts', 0);
  const withCoverage: EvidenceRecord = {
    ...rec,
    coverage: { ...EMPTY_COVERAGE, complete: false, truncated: true, reasons: ['size_limit'] },
  };
  const store = fakeStore([withCoverage]);
  const lex: ScoredRecord[] = [{ id: 'e1', type: 'evidence', sha: 'sha1', score: 1 }];
  const result = await chooseEvidence(lex, [], store as HistoryStore);
  assert.equal(result[0]!.excerpt, 'excerpt for e1');
  assert.equal(result[0]!.truncated, true);
  assert.deepEqual([...result[0]!.omissionReasons], ['size_limit']);
});
