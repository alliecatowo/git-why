import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  renderSearchErrorJson,
  renderSearchJson,
  renderStatusErrorJson,
  renderStatusJson,
} from '../../../src/output/json.js';
import { type CommitHit, type IndexStatus, type SearchResponse } from '../../../src/types.js';
import { validateAgainstSchema } from './schema-check.js';

const searchSchema = JSON.parse(
  readFileSync(new URL('../../../schema/search-response.schema.json', import.meta.url), 'utf8'),
);
const statusSchema = JSON.parse(
  readFileSync(new URL('../../../schema/status-response.schema.json', import.meta.url), 'utf8'),
);

function makeHit(overrides: Partial<CommitHit> = {}): CommitHit {
  return {
    sha: 'a'.repeat(40),
    subject: 'Fix infinite token-refresh loop',
    author: { name: 'Maya Chen', email: 'maya@example.invalid' },
    authorTime: 1762160400,
    committerTime: 1762160400,
    parents: ['b'.repeat(40)],
    messageExcerpt: 'Provider X can return an empty refresh token...',
    rankScore: 0.0325,
    scores: { fused: 0.0325, temporal: 1, final: 0.0325 },
    matchedBy: ['text', 'semantic'],
    linkDistance: 0,
    evidence: [
      {
        recordId: 'record-1',
        kind: 'hunk',
        path: {
          bytesBase64: Buffer.from('src/auth/refresh.ts').toString('base64'),
          display: 'src/auth/refresh.ts',
          lossy: false,
        },
        oldPath: null,
        changeType: 'M',
        oldStart: 72,
        oldCount: 1,
        newStart: 72,
        newCount: 1,
        excerpt:
          '- if (!refreshToken) throw new InvalidTokenError()\n+ if (!refreshToken) return currentSession',
        truncated: false,
        omissionReasons: [],
      },
    ],
    ...overrides,
  };
}

function makeResponse(overrides: Partial<SearchResponse> = {}): SearchResponse {
  return {
    query: 'auth refresh loop',
    coreQuery: 'auth refresh loop',
    mode: 'hybrid',
    sort: 'relevance',
    temporal: { intent: 'none', confidence: 'inferred', anchor: null, anchorEnd: null, w: 0 },
    answer: null,
    timeline: null,
    snapshot: {
      scope: 'branches-remotes-tags-worktree-heads',
      fingerprint: 'opaque-fingerprint',
      indexedAt: '2026-09-09T17:03:13Z',
      freshness: 'current',
      coverage: 'complete_for_policy',
      generation: 'opaque-generation',
    },
    results: [makeHit()],
    warnings: [],
    candidateLimitReached: false,
    ...overrides,
  };
}

function makeStatus(overrides: Partial<IndexStatus> = {}): IndexStatus {
  return {
    state: 'current',
    indexPath: '/repo/.git/why/index',
    generation: 'g3',
    indexedCommits: 1200,
    reachableCommits: 1200,
    refsChanged: false,
    recordCount: 9000,
    model: { id: 'potion-code-16m-v2', revision: 'r1', fingerprint: 'fp' },
    diskBytes: 12345,
    indexedAt: '2026-09-09T17:03:13Z',
    objectFormat: 'sha1',
    shallow: false,
    coverage: { excludedFiles: 0, unavailableFiles: 0, failedFiles: 0, reasons: [] },
    warnings: [],
    ...overrides,
  };
}

test('a well-formed search response renders as exactly one valid JSON object matching the schema', () => {
  const { text, outputTruncated } = renderSearchJson(makeResponse(), { maxBytes: 16 * 1024 });
  assert.equal(outputTruncated, false);
  const parsed: unknown = JSON.parse(text); // throws if not valid JSON
  const result = validateAgainstSchema(parsed, searchSchema);
  assert.deepEqual(result.errors, []);
  assert.ok(result.valid);
});

test('the search envelope never contains stored embeddings', () => {
  const { text } = renderSearchJson(makeResponse(), { maxBytes: 16 * 1024 });
  assert.ok(!text.includes('embedding'));
  assert.ok(!text.includes('vector'));
});

test('full SHAs are preserved verbatim in JSON', () => {
  const { text } = renderSearchJson(makeResponse(), { maxBytes: 64 * 1024 });
  const parsed = JSON.parse(text);
  assert.equal(parsed.results[0].sha.length, 40);
});

test('a lossy path includes pathBytesBase64', () => {
  const hit = makeHit({
    evidence: [
      {
        ...makeHit().evidence[0]!,
        path: {
          bytesBase64: Buffer.from([0xff, 0xfe]).toString('base64'),
          display: '��',
          lossy: true,
        },
      },
    ],
  });
  const { text } = renderSearchJson(makeResponse({ results: [hit] }), { maxBytes: 64 * 1024 });
  const parsed = JSON.parse(text);
  assert.ok(typeof parsed.results[0].evidence[0].pathBytesBase64 === 'string');
});

test('an extremely small --max-bytes still produces a single valid JSON object, with outputTruncated true', () => {
  const response = makeResponse({
    results: [makeHit(), makeHit({ sha: 'c'.repeat(40) }), makeHit({ sha: 'd'.repeat(40) })],
  });
  const { text, outputTruncated } = renderSearchJson(response, { maxBytes: 600 });
  const parsed = JSON.parse(text); // must not throw
  assert.equal(outputTruncated, true);
  assert.equal(parsed.outputTruncated, true);
  const result = validateAgainstSchema(parsed, searchSchema);
  assert.deepEqual(result.errors, []);
});

test('truncation drops evidence before dropping whole results', () => {
  // Budget large enough for one result with no evidence *plus* the
  // truncation warning that gets added once truncation happens, but not
  // enough for one result with its evidence attached.
  const response = makeResponse({ results: [makeHit()] });
  const fullSize = renderSearchJson(response, { maxBytes: 1024 * 1024 }).text.length;

  // Find this size empirically rather than predicting it: the exact byte
  // cost of adding the truncation warning depends on JSON string escaping
  // and indentation, which is an implementation detail this test shouldn't
  // hardcode.
  const noEvidenceTruncatedSize = renderSearchJson(response, { maxBytes: fullSize - 1 }).text
    .length;
  assert.ok(
    noEvidenceTruncatedSize < fullSize,
    'test setup: dropping evidence must shrink the envelope',
  );

  const budget = noEvidenceTruncatedSize + 10;
  const { text, outputTruncated } = renderSearchJson(response, { maxBytes: budget });
  const parsed = JSON.parse(text);
  assert.equal(outputTruncated, true);
  assert.equal(
    parsed.results.length,
    1,
    'the result itself should survive; only its evidence should be dropped',
  );
  assert.equal(parsed.results[0].evidence.length, 0);
});

test('a large enough --max-bytes truncates nothing', () => {
  const { outputTruncated } = renderSearchJson(makeResponse(), { maxBytes: 256 * 1024 });
  assert.equal(outputTruncated, false);
});

test('the failure envelope matches the schema and carries the error code', () => {
  const text = renderSearchErrorJson({
    query: 'refresh loop',
    mode: 'hybrid',
    code: 'INDEX_BUSY',
    message: 'Another process is indexing.',
    hint: 'Try again shortly, or increase --lock-timeout.',
  });
  const parsed = JSON.parse(text);
  assert.equal(parsed.schemaVersion, 2);
  assert.deepEqual(parsed.results, []);
  assert.equal(parsed.error.code, 'INDEX_BUSY');
  const result = validateAgainstSchema(parsed, searchSchema);
  assert.deepEqual(result.errors, []);
});

test('a status response matches the status schema', () => {
  const text = renderStatusJson('status', makeStatus());
  const parsed = JSON.parse(text);
  assert.equal(parsed.schemaVersion, 2);
  assert.equal(parsed.command, 'status');
  const result = validateAgainstSchema(parsed, statusSchema);
  assert.deepEqual(result.errors, []);
});

test('a status error response matches the status schema', () => {
  const text = renderStatusErrorJson(
    'rebuild',
    'MODEL_UNAVAILABLE',
    'No model is cached and --offline was set.',
    undefined,
  );
  const parsed = JSON.parse(text);
  assert.equal(parsed.command, 'rebuild');
  assert.equal(parsed.index, null);
  const result = validateAgainstSchema(parsed, statusSchema);
  assert.deepEqual(result.errors, []);
});

test('IndexStatus with a null model and null generation (a fresh "missing" index) still matches the schema', () => {
  const text = renderStatusJson(
    'status',
    makeStatus({
      state: 'missing',
      generation: null,
      indexedCommits: null,
      reachableCommits: null,
      recordCount: null,
      model: null,
      diskBytes: null,
      indexedAt: null,
    }),
  );
  const parsed = JSON.parse(text);
  const result = validateAgainstSchema(parsed, statusSchema);
  assert.deepEqual(result.errors, []);
});
