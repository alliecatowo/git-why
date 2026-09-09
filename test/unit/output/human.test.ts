import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderSearchHuman, renderStatusHuman } from '../../../src/output/human.js';
import type { CommitHit, IndexStatus } from '../../../src/types.js';

function makeHit(overrides: Partial<CommitHit> = {}): CommitHit {
  return {
    sha: '91ad2038c9d1234567890abcdef1234567890ab',
    subject: 'Fix infinite token-refresh loop',
    author: { name: 'Maya Chen', email: 'maya@example.invalid' },
    authorTime: 1762160400,
    committerTime: 1762160400, // 2025-11-03T09:00:00Z
    parents: ['b'.repeat(40)],
    messageExcerpt:
      'Provider X can return an empty refresh token while the current access\ntoken remains valid.',
    rankScore: 0.0325,
    matchedBy: ['text', 'semantic'],
    evidence: [
      {
        recordId: 'r1',
        kind: 'hunk',
        path: { bytesBase64: '', display: 'src/auth/refresh.ts', lossy: false },
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

test('a result renders SHA, subject, date, author, message, path and diff', () => {
  const out = renderSearchHuman({ query: 'q', results: [makeHit()], warnings: [] });
  assert.ok(out.includes('1. 91ad203  Fix infinite token-refresh loop'));
  assert.ok(out.includes('· Maya Chen'));
  assert.ok(out.includes('src/auth/refresh.ts'));
  assert.ok(out.includes('- if (!refreshToken) throw new InvalidTokenError()'));
  assert.ok(out.includes('+ if (!refreshToken) return currentSession'));
});

test('the SHA is shortened to 7 characters in human output, unlike JSON', () => {
  const out = renderSearchHuman({ query: 'q', results: [makeHit()], warnings: [] });
  assert.ok(!out.includes('91ad2038c9d1234567890abcdef1234567890ab'));
});

test('rankScore never appears in human output, as a number or a percentage', () => {
  const out = renderSearchHuman({
    query: 'q',
    results: [makeHit({ rankScore: 0.874 })],
    warnings: [],
  });
  assert.ok(!out.includes('0.874'));
  assert.ok(!out.includes('87.4%'));
  assert.ok(!out.includes('%'));
});

test('multiple results are numbered in order and separated by a blank line', () => {
  const out = renderSearchHuman({
    query: 'q',
    results: [makeHit(), makeHit({ sha: 'c'.repeat(40), subject: 'Second commit' })],
    warnings: [],
  });
  assert.ok(out.includes('1. 91ad203'));
  assert.ok(out.includes('2. ccccccc  Second commit'));
});

test('an empty result set uses neutral language, not a claim of proven absence', () => {
  const out = renderSearchHuman({ query: 'reconnect storm', results: [], warnings: [] });
  assert.ok(out.includes('No match found'));
  assert.ok(out.toLowerCase().includes('does not prove'));
});

test('a result with no evidence is marked as summary-only rather than fabricating a diff', () => {
  const out = renderSearchHuman({ query: 'q', results: [makeHit({ evidence: [] })], warnings: [] });
  assert.ok(out.includes('summary only'));
});

test('a rename shows old path -> new path', () => {
  const hit = makeHit({
    evidence: [
      {
        ...makeHit().evidence[0]!,
        path: { bytesBase64: '', display: 'src/new.ts', lossy: false },
        oldPath: { bytesBase64: '', display: 'lib/old.ts', lossy: false },
        changeType: 'R',
      },
    ],
  });
  const out = renderSearchHuman({ query: 'q', results: [hit], warnings: [] });
  assert.ok(out.includes('lib/old.ts -> src/new.ts'));
});

test('warnings are rendered, prefixed for visibility', () => {
  const out = renderSearchHuman({
    query: 'q',
    results: [makeHit()],
    warnings: ['candidate pool capped at 200'],
  });
  assert.ok(out.includes('warning: candidate pool capped at 200'));
});

test('a commit message containing an ANSI escape is sanitized before reaching the terminal', () => {
  const hit = makeHit({ subject: 'Fix bug \x1b[31m(evil)\x1b[0m' });
  const out = renderSearchHuman({ query: 'q', results: [hit], warnings: [] });
  assert.ok(!out.includes('\x1b'));
  assert.ok(out.includes('Fix bug (evil)'));
});

test('an author name containing a control sequence is sanitized', () => {
  const hit = makeHit({
    author: { name: 'Evil\x1b]8;;http://x\x07Author', email: 'e@example.invalid' },
  });
  const out = renderSearchHuman({ query: 'q', results: [hit], warnings: [] });
  assert.ok(!out.includes('\x1b'));
});

test('a diff excerpt containing a control sequence is sanitized', () => {
  const hit = makeHit({
    evidence: [{ ...makeHit().evidence[0]!, excerpt: '- old\x1b[2Jline\n+ new line' }],
  });
  const out = renderSearchHuman({ query: 'q', results: [hit], warnings: [] });
  assert.ok(!out.includes('\x1b'));
});

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

test('status renders state, counts and model identity', () => {
  const out = renderStatusHuman(makeStatus());
  assert.ok(out.includes('current'));
  assert.ok(out.includes('1200'));
  assert.ok(out.includes('potion-code-16m-v2'));
});

test('a missing index reports null fields without crashing', () => {
  const out = renderStatusHuman(
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
  assert.ok(out.includes('missing'));
  assert.ok(out.includes('never'));
});
