import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_CANDIDATE_POOL_CAP,
  MIN_CANDIDATE_POOL,
  rankCommits,
} from '../../../src/search/rank.js';
import type { ScoredRecord } from '../../../src/types.js';

function rec(
  sha: string,
  score: number,
  type: 'commit' | 'evidence' = 'evidence',
  id?: string,
): ScoredRecord {
  return { id: id ?? `${sha}-${type}-${score}`, type, sha, score };
}

test('five distinct top scores mean five distinct commits, not five hunks from one commit', async () => {
  // One commit contributes 20 duplicate-scoring hunk records; four other
  // commits contribute one record each with a lower score. Naive top-5-by-
  // record-score would return only the big commit's hunks.
  const bigCommitRecords = Array.from({ length: 20 }, (_, i) =>
    rec('big', 100, 'evidence', `big-${i}`),
  );
  const others = ['c1', 'c2', 'c3', 'c4'].map((sha, i) => rec(sha, 50 - i, 'evidence'));
  const lexicalFetch = async () => [...bigCommitRecords, ...others];

  const result = await rankCommits({ n: 5, lexicalFetch, semanticFetch: null });
  const top5 = result.ranked.slice(0, 5).map((r) => r.sha);
  assert.equal(new Set(top5).size, 5);
  assert.deepEqual(new Set(top5), new Set(['big', 'c1', 'c2', 'c3', 'c4']));
});

test('a huge commit with duplicate-message hunks does not out-rank distinct commits by sheer count', async () => {
  // 30 identical-score hunks for "spammy", vs one strong hit each for two
  // other commits that should still both appear ranked above nothing lost.
  const spammy = Array.from({ length: 30 }, (_, i) => rec('spammy', 10, 'evidence', `spam-${i}`));
  const real = [rec('real1', 99), rec('real2', 95)];
  const lexicalFetch = async () => [...spammy, ...real];

  const result = await rankCommits({ n: 3, lexicalFetch, semanticFetch: null });
  const order = result.ranked.map((r) => r.sha);
  assert.equal(order.indexOf('real1'), 0);
  assert.equal(order.indexOf('real2'), 1);
  // "spammy" collapses to a single commit entry regardless of its 30 records.
  assert.equal(order.filter((s) => s === 'spammy').length, 1);
});

test('RRF fuses two branches by rank, not by adding raw scores', async () => {
  // Branch scores are on wildly different, non-comparable scales (BM25 vs
  // cosine-like); only rank position may be used.
  const lexicalFetch = async () => [rec('a', 1000), rec('b', 1)];
  const semanticFetch = async () => [rec('b', 0.99), rec('a', 0.01)];

  const result = await rankCommits({ n: 2, lexicalFetch, semanticFetch });
  const bySha = new Map(result.ranked.map((r) => [r.sha, r.score]));
  // a: lexical rank 1, semantic rank 2 -> 1/61 + 1/62
  // b: lexical rank 2, semantic rank 1 -> 1/62 + 1/61
  const expected = 1 / 61 + 1 / 62;
  assert.ok(Math.abs(bySha.get('a')! - expected) < 1e-12);
  assert.ok(Math.abs(bySha.get('b')! - expected) < 1e-12);
  // Tied fused score: full-SHA tie-break decides order, not recency or raw score.
  assert.deepEqual(
    result.ranked.map((r) => r.sha),
    ['a', 'b'].sort(),
  );
});

test('a missing branch contributes zero, not a penalty', async () => {
  const lexicalFetch = async () => [rec('a', 5), rec('b', 3)];
  const result = await rankCommits({ n: 2, lexicalFetch, semanticFetch: null });
  const bySha = new Map(result.ranked.map((r) => [r.sha, r.score]));
  assert.ok(Math.abs(bySha.get('a')! - 1 / 61) < 1e-12);
  assert.ok(Math.abs(bySha.get('b')! - 1 / 62) < 1e-12);
});

test('single-mode search (one branch only) still produces a monotonic ranking number, not a raw score', async () => {
  const semanticFetch = async () => [rec('x', 0.9), rec('y', 0.1)];
  const result = await rankCommits({ n: 2, lexicalFetch: null, semanticFetch });
  assert.deepEqual(
    result.ranked.map((r) => r.sha),
    ['x', 'y'],
  );
  assert.notEqual(result.ranked[0]!.score, 0.9); // never the raw cosine value
});

test('matchedBy reports which branch(es) actually surfaced the commit', async () => {
  const lexicalFetch = async () => [rec('both', 1), rec('lex-only', 1)];
  const semanticFetch = async () => [rec('both', 1), rec('sem-only', 1)];
  const result = await rankCommits({ n: 3, lexicalFetch, semanticFetch });
  const byS = new Map(result.ranked.map((r) => [r.sha, r.matchedBy]));
  assert.deepEqual([...byS.get('both')!].sort(), ['semantic', 'text']);
  assert.deepEqual(byS.get('lex-only'), ['text']);
  assert.deepEqual(byS.get('sem-only'), ['semantic']);
});

test('stable full-SHA tie-break never favours recency: identical scores order by SHA alone', async () => {
  const lexicalFetch = async () => [rec('zzzz', 5), rec('aaaa', 5)];
  const result = await rankCommits({ n: 2, lexicalFetch, semanticFetch: null });
  assert.deepEqual(
    result.ranked.map((r) => r.sha),
    ['aaaa', 'zzzz'],
  );
});

test('candidate pool expands geometrically when the first fetch has too few unique commits', async () => {
  const calls: number[] = [];
  // The store always returns exactly `topK` records (never "exhausted"),
  // but only one in every 50 records is a distinct commit -- a low-density
  // pool that forces repeated doubling before enough unique commits appear.
  const lexicalFetch = async (topK: number) => {
    calls.push(topK);
    const uniqueCount = Math.ceil(topK / 50);
    return Array.from({ length: topK }, (_, i) => rec(`c${i % uniqueCount}`, topK - i));
  };
  const result = await rankCommits({
    n: 10,
    lexicalFetch,
    semanticFetch: null,
    candidatePoolCap: 5000,
  });
  assert.ok(
    calls.length > 1,
    'must have queried more than once to satisfy n=10 from a low-density pool',
  );
  assert.ok(calls[0]! >= MIN_CANDIDATE_POOL);
  // Every subsequent call requests strictly more than the previous (geometric growth).
  for (let i = 1; i < calls.length; i += 1) assert.ok(calls[i]! > calls[i - 1]!);
  assert.ok(new Set(result.ranked.map((r) => r.sha)).size >= 10);
});

test('candidateLimitReached is set when the bounded cap still limits diversity below what was requested', async () => {
  const lexicalFetch = async (topK: number) => {
    // The store always has only 10 unique commits available, but never
    // reports "exhausted" by returning fewer than requested (a pathological
    // store that pads/repeats) -- exercise the cap path explicitly.
    const capped = Math.min(topK, 10);
    return Array.from({ length: topK }, (_, i) => rec(`c${i % capped}`, 1000 - i));
  };
  const result = await rankCommits({
    n: 50,
    lexicalFetch,
    semanticFetch: null,
    candidatePoolCap: 200,
  });
  assert.equal(result.candidateLimitReached, true);
});

test('candidateLimitReached is false when the pool is exhausted honestly (store has fewer records than requested)', async () => {
  const lexicalFetch = async (topK: number) => {
    const all = Array.from({ length: 10 }, (_, i) => rec(`c${i}`, 100 - i));
    return all.slice(0, Math.min(topK, all.length));
  };
  const result = await rankCommits({
    n: 50,
    lexicalFetch,
    semanticFetch: null,
    candidatePoolCap: 2000,
  });
  assert.equal(result.candidateLimitReached, false);
  assert.equal(result.ranked.length, 10);
});

test('lexicalRecordsBySha / semanticRecordsBySha group all fetched records for evidence selection', async () => {
  const lexicalFetch = async () => [rec('a', 5, 'evidence', 'e1'), rec('a', 3, 'commit', 'c1')];
  const result = await rankCommits({ n: 1, lexicalFetch, semanticFetch: null });
  const grouped = result.lexicalRecordsBySha.get('a')!;
  assert.equal(grouped.length, 2);
});

test('default candidate pool cap is a positive, sane bound', () => {
  assert.ok(DEFAULT_CANDIDATE_POOL_CAP > MIN_CANDIDATE_POOL);
});
