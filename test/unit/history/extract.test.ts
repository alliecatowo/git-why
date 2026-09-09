import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RawFileChange } from '../../../src/history/extract.js';
import { buildCommitExtraction, type RawCommitInput } from '../../../src/history/extract.js';
import type { HistoricalPath, HistoricalPathChange } from '../../../src/types.js';
import { PATCH_MAX_BYTES } from '../../../src/history/policy.js';
import { makeFakeEmbedder } from './fakes.js';

function hp(display: string): HistoricalPath {
  return { bytesBase64: Buffer.from(display).toString('base64'), display, lossy: false };
}

function change(path: string, changeType: HistoricalPathChange['changeType'] = 'M'): HistoricalPathChange {
  return {
    path: hp(path),
    oldPath: null,
    changeType,
    similarity: null,
    oldMode: null,
    newMode: null,
    oldBlob: null,
    newBlob: null,
  };
}

function baseCommit(files: RawFileChange[], overrides: Partial<RawCommitInput> = {}): RawCommitInput {
  return {
    sha: 'a'.repeat(40),
    parents: ['b'.repeat(40)],
    subject: 'Fix null refresh token',
    body: 'Provider X can return an empty refresh token.',
    author: { name: 'Maya Chen', email: 'maya@example.invalid', time: 1_700_000_000 },
    committerTime: 1_700_000_001,
    files,
    ...overrides,
  };
}

test('a simple modified file produces one hunk evidence record with labelled semantic text', () => {
  const c = change('src/auth/refresh.ts');
  const commit = baseCommit([
    {
      change: c,
      hunks: [
        {
          path: c.path,
          oldPath: null,
          changeType: 'M',
          hunkOrdinal: 0,
          header: '@@ -70,3 +70,3 @@',
          oldStart: 70,
          oldCount: 3,
          newStart: 70,
          newCount: 3,
          lines: [
            { kind: 'context', text: 'function refresh() {' },
            { kind: 'removed', text: '  if (!token) throw new InvalidTokenError()' },
            { kind: 'added', text: '  if (!token) return currentSession' },
            { kind: 'context', text: '}' },
          ],
        },
      ],
    },
  ]);

  const result = buildCommitExtraction(commit, makeFakeEmbedder());
  assert.equal(result.commit.sha, commit.sha);
  assert.equal(result.commit.coverage.complete, true);
  assert.equal(result.evidence.length, 1);

  const ev = result.evidence[0]!;
  assert.equal(ev.kind, 'hunk');
  assert.equal(ev.path.display, 'src/auth/refresh.ts');
  assert.ok(ev.semanticText.includes('Removed code'));
  assert.ok(ev.semanticText.includes('Added code'));
  assert.ok(ev.semanticText.includes('InvalidTokenError'));
  assert.equal(ev.coverage.complete, true);
});

test('source excerpt is a faithful copy of the diff; lexical text is normalised and differs', () => {
  const c = change('src/auth/AuthSessionProvider.ts');
  const commit = baseCommit([
    {
      change: c,
      hunks: [
        {
          path: c.path,
          oldPath: null,
          changeType: 'M',
          hunkOrdinal: 0,
          header: null,
          oldStart: 1,
          oldCount: 1,
          newStart: 1,
          newCount: 1,
          lines: [{ kind: 'removed', text: 'const max_retry_count = 13' }],
        },
      ],
    },
  ]);
  const result = buildCommitExtraction(commit, makeFakeEmbedder());
  const ev = result.evidence[0]!;
  assert.equal(ev.sourceExcerpt, '-const max_retry_count = 13');
  assert.ok(ev.lexicalText.includes('max_retry_count'));
  assert.ok(ev.lexicalText.split(' ').includes('max'));
  assert.ok(ev.lexicalText.split(' ').includes('13'));
  assert.notEqual(ev.lexicalText, ev.sourceExcerpt);
});

test('a lockfile change is retained as file_change metadata, not silently dropped', () => {
  const c = change('package-lock.json');
  const commit = baseCommit([{ change: c, hunks: [] }]);
  const result = buildCommitExtraction(commit, makeFakeEmbedder());
  assert.equal(result.evidence.length, 1);
  const ev = result.evidence[0]!;
  assert.equal(ev.kind, 'file_change');
  assert.deepEqual([...ev.coverage.reasons], ['lockfile']);
  assert.equal(result.commit.coverage.excludedFiles, 1);
  // The commit summary itself always retains the changed path regardless.
  assert.ok(result.commit.changedPaths.some((cp) => cp.path.display === 'package-lock.json'));
});

test('a mode-only / no-hunk change still produces a file_change record, never silently vanishes', () => {
  const c = change('bin/tool.sh', 'T');
  const commit = baseCommit([{ change: c, hunks: [] }]);
  const result = buildCommitExtraction(commit, makeFakeEmbedder());
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0]!.kind, 'file_change');
  assert.deepEqual([...result.evidence[0]!.coverage.reasons], []);
});

test('a pathological commit keeps the summary but skips fine-grained extraction', () => {
  const c = change('src/generated.ts');
  const hugeLine = 'x'.repeat(1024);
  const lines = Array.from({ length: Math.ceil(PATCH_MAX_BYTES / hugeLine.length) + 10 }, () => ({
    kind: 'added' as const,
    text: hugeLine,
  }));
  const commit = baseCommit([
    {
      change: c,
      hunks: [
        {
          path: c.path,
          oldPath: null,
          changeType: 'M',
          hunkOrdinal: 0,
          header: null,
          oldStart: null,
          oldCount: null,
          newStart: 1,
          newCount: lines.length,
          lines,
        },
      ],
    },
  ]);
  const result = buildCommitExtraction(commit, makeFakeEmbedder());
  assert.equal(result.evidence.length, 0);
  assert.ok(result.commit.coverage.reasons.includes('pathological_commit'));
  assert.equal(result.commit.coverage.excludedFiles, 1);
  // The commit's own summary text must still be present.
  assert.ok(result.commit.semanticText.length > 0);
});

test('an oversized commit round-robins across files under the slice budget deterministically', () => {
  const files: RawFileChange[] = Array.from({ length: 100 }, (_, i) => {
    const c = change(`src/file${String(i).padStart(3, '0')}.ts`);
    return {
      change: c,
      hunks: [
        {
          path: c.path,
          oldPath: null,
          changeType: 'M' as const,
          hunkOrdinal: 0,
          header: null,
          oldStart: 1,
          oldCount: 1,
          newStart: 1,
          newCount: 1,
          lines: [{ kind: 'added' as const, text: `line ${i}` }],
        },
      ],
    };
  });
  const commit = baseCommit(files);
  const embedder = makeFakeEmbedder();
  const a = buildCommitExtraction(commit, embedder);
  const b = buildCommitExtraction(commit, embedder);

  assert.ok(a.evidence.length <= 64);
  assert.ok(a.commit.coverage.reasons.includes('slice_limit'));
  assert.ok(a.commit.coverage.excludedFiles > 0);
  // Deterministic: identical input, identical output (ids, order, everything).
  assert.deepEqual(
    a.evidence.map((e) => e.id),
    b.evidence.map((e) => e.id),
  );
});

test('a huge commit message does not prevent the commit record from being built, and is flagged', () => {
  const c = change('README.md');
  const commit = baseCommit([{ change: c, hunks: [] }], { body: 'x'.repeat(20_000) });
  const result = buildCommitExtraction(commit, makeFakeEmbedder());
  assert.ok(result.commit.coverage.reasons.includes('message_limit'));
});

test('commit and evidence ids are deterministic across repeated extraction of identical input', () => {
  const c = change('src/a.ts');
  const commit = baseCommit([
    {
      change: c,
      hunks: [
        {
          path: c.path,
          oldPath: null,
          changeType: 'M',
          hunkOrdinal: 0,
          header: null,
          oldStart: 1,
          oldCount: 1,
          newStart: 1,
          newCount: 1,
          lines: [{ kind: 'added', text: 'x' }],
        },
      ],
    },
  ]);
  const embedder = makeFakeEmbedder();
  const a = buildCommitExtraction(commit, embedder);
  const b = buildCommitExtraction(commit, embedder);
  assert.equal(a.commit.id, b.commit.id);
  assert.deepEqual(
    a.evidence.map((e) => e.id),
    b.evidence.map((e) => e.id),
  );
});
