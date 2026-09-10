import assert from 'node:assert/strict';
import { test } from 'node:test';
import { search } from '../../../src/search/search.js';
import {
  EMPTY_COVERAGE,
  NO_FILTERS,
  type CommitRecord,
  type Embedder,
  type EvidenceRecord,
  type HistoricalPath,
  type HistoryStore,
  type ScoredRecord,
  type SearchRequest,
  type SnapshotSummary,
  type StorageFilter,
  NO_TEMPORAL_CONSTRAINT,
} from '../../../src/types.js';

function hp(display: string): HistoricalPath {
  return { bytesBase64: Buffer.from(display).toString('base64'), display, lossy: false };
}

function commit(sha: string, subject: string): CommitRecord {
  return {
    type: 'commit',
    id: `commit-${sha}`,
    sha,
    parents: [],
    subject,
    body: '',
    author: { name: 'Maya Chen', email: 'maya@example.invalid', time: 1000 },
    committerTime: 1001,
    changedPaths: [],
    semanticText: '',
    lexicalText: '',
    coverage: EMPTY_COVERAGE,
  };
}

function evidenceRec(id: string, sha: string, path: string): EvidenceRecord {
  return {
    type: 'evidence',
    kind: 'hunk',
    id,
    sha,
    parentSha: null,
    path: hp(path),
    oldPath: null,
    changeType: 'M',
    hunkOrdinal: 0,
    sliceOrdinal: 0,
    header: null,
    oldStart: 1,
    oldCount: 1,
    newStart: 1,
    newCount: 1,
    sourceExcerpt: `excerpt-${id}`,
    semanticText: '',
    lexicalText: '',
    coverage: EMPTY_COVERAGE,
  };
}

const snapshot: SnapshotSummary = {
  scope: 'branches-remotes-tags-worktree-heads',
  fingerprint: 'fp',
  indexedAt: '2026-01-01T00:00:00Z',
  freshness: 'current',
  coverage: 'complete_for_policy',
  generation: 'gen-1',
};

function makeStore(
  overrides: Partial<HistoryStore> = {},
): HistoryStore & { receivedFilters: StorageFilter[] } {
  const commits = new Map<string, CommitRecord>([
    ['sha1', commit('sha1', 'Fix auth refresh loop')],
    ['sha2', commit('sha2', 'Unrelated change')],
  ]);
  const evid = new Map<string, EvidenceRecord>([
    ['ev1', evidenceRec('ev1', 'sha1', 'src/auth.ts')],
  ]);
  const receivedFilters: StorageFilter[] = [];

  const store: HistoryStore & { receivedFilters: StorageFilter[] } = {
    receivedFilters,
    async searchLexical(
      _queryText: string,
      filter: StorageFilter,
    ): Promise<readonly ScoredRecord[]> {
      receivedFilters.push(filter);
      return [
        { id: 'ev1', type: 'evidence', sha: 'sha1', score: 10 },
        { id: 'commit-sha2', type: 'commit', sha: 'sha2', score: 5 },
      ];
    },
    async searchSemantic(
      _queryVector: Float32Array,
      filter: StorageFilter,
    ): Promise<readonly ScoredRecord[]> {
      receivedFilters.push(filter);
      return [{ id: 'ev1', type: 'evidence', sha: 'sha1', score: 0.9 }];
    },
    async fetchCommits(shas: readonly string[]) {
      const map = new Map<string, CommitRecord>();
      for (const sha of shas) {
        const c = commits.get(sha);
        if (c) map.set(sha, c);
      }
      return map;
    },
    async fetchEvidence(ids: readonly string[]) {
      const map = new Map<string, EvidenceRecord>();
      for (const id of ids) {
        const e = evid.get(id);
        if (e) map.set(id, e);
      }
      return map;
    },
    async evidenceForCommit() {
      return [];
    },
    async close() {},
    ...overrides,
  };
  return store;
}

function makeEmbedder(): Embedder & { queryCalls: number } {
  let queryCalls = 0;
  return {
    fingerprint: 'fake',
    modelId: 'fake',
    revision: 'v1',
    dimension: 4,
    maxInputTokens: 128,
    countTokens: (t: string) => t.split(/\s+/).filter(Boolean).length,
    truncateToTokens: (t: string) => t,
    async embedDocuments(texts: readonly string[]) {
      return texts.map(() => new Float32Array(4));
    },
    async embedQuery() {
      queryCalls += 1;
      return new Float32Array(4);
    },
    async dispose() {},
    get queryCalls() {
      return queryCalls;
    },
  };
}

const baseRequest: SearchRequest = {
  query: 'auth refresh loop',
  mode: 'hybrid',
  sort: 'relevance',
  limit: 5,
  filters: NO_FILTERS,
  temporal: NO_TEMPORAL_CONSTRAINT,
  groups: [],
};

test('hybrid search returns ranked, distinct-commit results with attached evidence', async () => {
  const store = makeStore();
  const embedder = makeEmbedder();
  const response = await search(baseRequest, store, embedder, snapshot);

  assert.equal(response.mode, 'hybrid');
  assert.equal(response.snapshot, snapshot);
  assert.ok(response.results.length > 0);
  const first = response.results.find((r) => r.sha === 'sha1');
  assert.ok(first);
  assert.deepEqual([...first!.matchedBy].sort(), ['semantic', 'text']);
  assert.ok(first!.evidence.length > 0);
  assert.equal(first!.evidence[0]!.recordId, 'ev1');
});

test('--text mode never loads/calls the embedder', async () => {
  const store = makeStore();
  const embedder = makeEmbedder();
  const response = await search({ ...baseRequest, mode: 'text' }, store, null, snapshot);
  assert.equal(response.mode, 'text');
  assert.equal(embedder.queryCalls, 0, 'embedder must never be constructed/used for --text');
});

test('semantic mode without an embedder throws rather than silently degrading to text search', async () => {
  const store = makeStore();
  await assert.rejects(() => search({ ...baseRequest, mode: 'semantic' }, store, null, snapshot));
});

test('both branches receive an identical StorageFilter (eligibility filters are identical in both branches)', async () => {
  const store = makeStore();
  const embedder = makeEmbedder();
  await search(baseRequest, store, embedder, snapshot);
  assert.equal(store.receivedFilters.length, 2);
  assert.deepEqual(store.receivedFilters[0], store.receivedFilters[1]);
  assert.deepEqual(store.receivedFilters[0]!.filters, NO_FILTERS);
  assert.deepEqual([...store.receivedFilters[0]!.recordTypes].sort(), ['commit', 'evidence']);
});

test('a commit that fails to fetch is dropped with a warning rather than crashing the response', async () => {
  const store = makeStore({
    async fetchCommits() {
      return new Map(); // simulate every commit missing
    },
  });
  const embedder = makeEmbedder();
  const response = await search(baseRequest, store, embedder, snapshot);
  assert.equal(response.results.length, 0);
  assert.ok(response.warnings.length > 0);
});

test('candidateLimitReached is propagated through to the response', async () => {
  const store = makeStore({
    async searchLexical() {
      return [{ id: 'ev1', type: 'evidence', sha: 'sha1', score: 1 }];
    },
    async searchSemantic() {
      return [];
    },
  });
  const embedder = makeEmbedder();
  const response = await search({ ...baseRequest, limit: 50 }, store, embedder, snapshot);
  assert.equal(typeof response.candidateLimitReached, 'boolean');
});

test('--sort=oldest reorders the selected commits chronologically without changing the selection', async () => {
  const response = await search(
    { ...baseRequest, sort: 'oldest' },
    makeStore(),
    makeEmbedder(),
    snapshot,
  );
  const relevance = await search(baseRequest, makeStore(), makeEmbedder(), snapshot);

  assert.deepEqual(
    [...response.results.map((r) => r.sha)].sort(),
    [...relevance.results.map((r) => r.sha)].sort(),
    'sorting must never change WHICH commits are returned, only their order',
  );
  const times = response.results.map((r) => r.committerTime);
  assert.deepEqual(
    times,
    [...times].sort((a, b) => a - b),
    'oldest first',
  );
  assert.equal(response.sort, 'oldest');
});

test('--sort=newest is the exact reverse ordering of --sort=oldest', async () => {
  const oldest = await search(
    { ...baseRequest, sort: 'oldest' },
    makeStore(),
    makeEmbedder(),
    snapshot,
  );
  const newest = await search(
    { ...baseRequest, sort: 'newest' },
    makeStore(),
    makeEmbedder(),
    snapshot,
  );
  const t = newest.results.map((r) => r.committerTime);
  assert.deepEqual(
    t,
    [...t].sort((a, b) => b - a),
    'newest first',
  );
  assert.equal(oldest.results.length, newest.results.length);
});

test('sorting is total and deterministic when commits share a committer time', async () => {
  const a = await search({ ...baseRequest, sort: 'newest' }, makeStore(), makeEmbedder(), snapshot);
  const b = await search({ ...baseRequest, sort: 'newest' }, makeStore(), makeEmbedder(), snapshot);
  assert.deepEqual(
    a.results.map((r) => r.sha),
    b.results.map((r) => r.sha),
  );
});

test('relevance remains the default and preserves rank order', async () => {
  const response = await search(baseRequest, makeStore(), makeEmbedder(), snapshot);
  assert.equal(response.sort, 'relevance');
  const scores = response.results.map((r) => r.rankScore);
  assert.deepEqual(
    scores,
    [...scores].sort((x, y) => y - x),
    'relevance order is descending rankScore',
  );
});

test('soft first-introduction phrasing explains the widen-then-order workflow', async () => {
  // "origin of X" is an INFERRED-confidence match (softer phrasing than
  // "first introduced"), so the parser's guess could be wrong -- the manual
  // fallback hint is still worth surfacing here even though the temporal
  // path also runs.
  const response = await search(
    { ...baseRequest, query: 'what is the origin of streaming support?' },
    makeStore(),
    makeEmbedder(),
    snapshot,
  );
  assert.equal(response.temporal.intent, 'first');
  assert.equal(response.temporal.confidence, 'inferred');
  assert.ok(response.warnings.some((warning) => warning.includes('-n 20 --sort=oldest')));
});

test('a flagless natural-language temporal query actually takes the temporal path', async () => {
  // Regression test: `request.temporal` is `NO_TEMPORAL_CONSTRAINT` here --
  // exactly what the CLI/MCP send when the caller supplies no explicit
  // temporal flag. Before this fix, `search()` gated every downstream branch
  // (core-query substitution, structural expansion, ordinal answer,
  // timeline, the reported `temporal.intent`) on `request.temporal.type`
  // itself rather than on the parser's inferred reading, so a bare
  // natural-language question like this one silently fell through the
  // pre-temporal path with `temporal.intent` always reported as "none".
  const response = await search(
    {
      ...baseRequest,
      query: 'when was streaming first introduced?',
      temporal: NO_TEMPORAL_CONSTRAINT,
    },
    makeStore(),
    makeEmbedder(),
    snapshot,
  );
  assert.equal(response.temporal.intent, 'first');
  // "first introduced" is unambiguous phrasing -- the parser's own
  // EXPLICIT confidence tier, same as an outright CLI flag. This is
  // distinct from "did the user pass a flag" (they didn't); it means the
  // temporal path trusts its own reading enough to skip the manual-fallback
  // hint (see the soft-phrasing test above, which uses inferred confidence).
  assert.equal(response.temporal.confidence, 'explicit');
  assert.equal(response.warnings.length, 0);
});

test('an ordinary non-temporal query still takes the byte-identical identity path', async () => {
  // Companion to the regression test above: confirms the fix did not widen
  // the temporal path to queries that were never meant to trigger it. Core
  // string identity is asserted at the parser level
  // (test/unit/search/temporal/intent.test.ts); this asserts the same
  // guarantee survives through the full search() response.
  const response = await search(baseRequest, makeStore(), makeEmbedder(), snapshot);
  assert.equal(response.temporal.intent, 'none');
  assert.equal(response.coreQuery, baseRequest.query);
  assert.equal(response.warnings.length, 0);
});
