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
    scores: { fused: 0.0325, temporal: 1, final: 0.0325 },
    matchedBy: ['text', 'semantic'],
    linkDistance: 0,
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
    lineageBytes: null,
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
      lineageBytes: null,
      indexedAt: null,
    }),
  );
  assert.ok(out.includes('missing'));
  assert.ok(out.includes('never'));
});

// The ordinal answer is resolved from the lineage table, not from the ranked
// list, so it is routinely absent from `results`. Rendering only the list
// therefore hid the answer the flag was asked for -- `--first` printed ten
// unrelated commits and nothing else, and the answer was reachable only via
// `--json`. These tests pin the answer to the human output.
test('an ordinal answer leads the results, with subject, date and what it was keyed on', () => {
  const out = renderSearchHuman({
    query: 'when was HTTP/3 support first introduced',
    results: [makeHit()],
    warnings: [],
    answer: {
      sha: '3af0e76d1e71995b7790c74e79b76af86ee7c681',
      kind: 'introduced',
      subject: 'HTTP3: initial (experimental) support',
      committerTime: 1563667200, // 2019-07-21
      viaToken: 'http3',
      viaPath: null,
      confidence: 'explicit',
    },
  });
  const first = out.split('\n')[0];
  assert.equal(
    first,
    'introduced: 3af0e76  HTTP3: initial (experimental) support  2019-07-21  (by http3)',
  );
  // It leads: the answer is the answer, the results are surrounding evidence.
  assert.ok(out.indexOf('introduced:') < out.indexOf('1. 91ad203'));
});

test('the three ordinal kinds are labelled distinctly', () => {
  const base = {
    sha: 'c'.repeat(40),
    subject: 'Drop the vendored parser',
    committerTime: 1563667200,
    viaToken: null,
    viaPath: 'src/parser.ts',
    confidence: 'explicit',
  } as const;
  const render = (kind: 'introduced' | 'last_modified' | 'removed') =>
    renderSearchHuman({ query: 'q', results: [], warnings: [], answer: { ...base, kind } }).split(
      '\n',
    )[0] ?? '';
  assert.match(render('introduced'), /^introduced: /);
  assert.match(render('last_modified'), /^last changed: /);
  assert.match(render('removed'), /^removed: /);
  // Keying by path rather than token is named the same way, so the claim
  // stays checkable either way.
  assert.ok(render('removed').endsWith('(by src/parser.ts)'));
});

test('an answer with no subject or date still renders its SHA rather than vanishing', () => {
  const out = renderSearchHuman({
    query: 'q',
    results: [],
    warnings: [],
    answer: {
      sha: 'd'.repeat(40),
      kind: 'introduced',
      subject: null,
      committerTime: null,
      viaToken: null,
      viaPath: null,
      confidence: 'inferred',
    },
  });
  assert.equal(out.split('\n')[0], 'introduced: ddddddd');
});

test('no answer means no answer line, so ordinary queries are unchanged', () => {
  const out = renderSearchHuman({ query: 'q', results: [makeHit()], warnings: [] });
  assert.ok(out.startsWith('1. 91ad203'));
});

// `--owners` and `--timeline` had the same defect as the ordinal answer: the
// response carried a fully computed result and the human renderer dropped it,
// so both flags printed an ordinary ranked list and nothing else. The
// landing-page demo of `--owners` showed no owners at all.
test('owners lead the results, with share, commit count, active span and a checkable commit', () => {
  const out = renderSearchHuman({
    query: 'TLS backend abstraction',
    results: [makeHit()],
    warnings: [],
    owners: [
      {
        name: 'Daniel Stenberg',
        email: 'daniel@example.invalid',
        weight: 3,
        commits: 9,
        firstTime: 1406671547, // 2014-07-29
        lastTime: 1643268970, // 2022-01-27
        topCommits: [
          {
            sha: '2218c3a'.padEnd(40, '0'),
            subject: 'vtls: pass on the right SNI name',
            committerTime: 1643268970,
          },
        ],
      },
      {
        name: 'Steve Holme',
        email: 'steve@example.invalid',
        weight: 1,
        commits: 1,
        firstTime: 1406671547,
        lastTime: 1406671547,
        topCommits: [],
      },
    ],
  });
  // weight is a summed rank score, not a percentage; it is rendered as a
  // share of the total so it is comparable rather than merely large.
  assert.ok(
    out.includes(
      '1. Daniel Stenberg <daniel@example.invalid>  75%  9 commits  2014-07-29..2022-01-27',
    ),
  );
  assert.ok(out.includes('2218c3a  vtls: pass on the right SNI name'));
  // A single-day span is not printed as a range against itself.
  assert.ok(out.includes('2. Steve Holme <steve@example.invalid>  25%  1 commit  2014-07-29'));
  assert.ok(out.indexOf('owners,') < out.indexOf('1. 91ad203'));
});

test('a timeline renders in ancestry order with each episode kind', () => {
  const out = renderSearchHuman({
    query: 'HTTP/2 multiplexing',
    results: [],
    warnings: [],
    timeline: [
      {
        sha: 'a'.repeat(40),
        kind: 'introduced',
        committerTime: 1403136000,
        subject: 'first',
        evidence: null,
      },
      {
        sha: 'b'.repeat(40),
        kind: 'modified',
        committerTime: 1416441600,
        subject: 'middle',
        evidence: null,
      },
      {
        sha: 'c'.repeat(40),
        kind: 'removed',
        committerTime: 1424390400,
        subject: 'gone',
        evidence: null,
      },
    ],
  });
  const lines = out.split('\n');
  assert.equal(lines[0], 'timeline:');
  assert.ok(lines[1]?.includes('introduced') && lines[1]?.includes('first'));
  assert.ok(lines[3]?.includes('removed') && lines[3]?.includes('gone'));
});

test('empty owners and timeline add no heading, so an ordinary query is unchanged', () => {
  const out = renderSearchHuman({
    query: 'q',
    results: [makeHit()],
    warnings: [],
    owners: [],
    timeline: [],
  });
  assert.ok(out.startsWith('1. 91ad203'));
});
