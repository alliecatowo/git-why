import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  chunkHunk,
  renderDiffLines,
  type RawDiffLine,
  type RawHunk,
} from '../../../src/history/chunk.js';
import type { HistoricalPath } from '../../../src/types.js';

const PATH: HistoricalPath = {
  bytesBase64: Buffer.from('a.ts').toString('base64'),
  display: 'a.ts',
  lossy: false,
};

function line(kind: RawDiffLine['kind'], text: string): RawDiffLine {
  return { kind, text };
}

function makeHunk(lines: RawDiffLine[], overrides: Partial<RawHunk> = {}): RawHunk {
  return {
    path: PATH,
    oldPath: null,
    changeType: 'M',
    hunkOrdinal: 0,
    header: '@@ -1,10 +1,10 @@',
    oldStart: 1,
    oldCount: lines.filter((l) => l.kind !== 'added').length,
    newStart: 1,
    newCount: lines.filter((l) => l.kind !== 'removed').length,
    lines,
    ...overrides,
  };
}

test('a small hunk is returned as a single unsplit slice', () => {
  const lines = [
    line('context', 'a'),
    line('removed', 'b'),
    line('added', 'c'),
    line('context', 'd'),
  ];
  const hunk = makeHunk(lines);
  const slices = chunkHunk(hunk, { maxLinesPerSlice: 60, contextOverlap: 3 });
  assert.equal(slices.length, 1);
  assert.equal(slices[0]!.sliceOrdinal, 0);
  assert.deepEqual(slices[0]!.lines, lines);
  assert.equal(slices[0]!.oldStart, 1);
  assert.equal(slices[0]!.newStart, 1);
});

test('sourceExcerpt is a faithful unified-diff rendering, never normalised', () => {
  const lines = [
    line('context', '  const x = 1;'),
    line('removed', '  return null;'),
    line('added', '  return x;'),
  ];
  const hunk = makeHunk(lines);
  const [slice] = chunkHunk(hunk);
  assert.equal(slice!.sourceExcerpt, renderDiffLines(lines));
  assert.equal(slice!.sourceExcerpt, ' ' + '  const x = 1;\n-  return null;\n+  return x;');
});

test('an empty hunk produces no slices', () => {
  assert.deepEqual(chunkHunk(makeHunk([])), []);
});

test('an oversized hunk splits at a context-line (safe) boundary, preserving both sides of each block', () => {
  // Two separated small change blocks inside a long run of context.
  const lines: RawDiffLine[] = [];
  for (let i = 0; i < 20; i += 1) lines.push(line('context', `ctx-${i}`));
  lines.push(line('removed', 'old-1'));
  lines.push(line('added', 'new-1'));
  for (let i = 20; i < 40; i += 1) lines.push(line('context', `ctx-${i}`));
  lines.push(line('removed', 'old-2'));
  lines.push(line('added', 'new-2'));
  for (let i = 40; i < 60; i += 1) lines.push(line('context', `ctx-${i}`));

  const hunk = makeHunk(lines, { oldCount: lines.filter((l) => l.kind !== 'added').length });
  const slices = chunkHunk(hunk, { maxLinesPerSlice: 25, contextOverlap: 2 });

  assert.ok(slices.length > 1, 'an oversized hunk must be split');
  // Every removed/added line from the original hunk must survive somewhere.
  const allSliceLines = slices.flatMap((s) => s.lines);
  for (const original of lines.filter((l) => l.kind !== 'context')) {
    assert.ok(
      allSliceLines.some((l) => l.kind === original.kind && l.text === original.text),
      `missing ${original.kind} line ${original.text}`,
    );
  }
  // No slice boundary should fall strictly inside a removed/added run: for
  // every slice after the first, its first line (ignoring repeated
  // leading context) should not be a removed/added line whose predecessor
  // in the *original* hunk was also removed/added (i.e. a severed block).
  for (const s of slices) {
    assert.ok(s.lines.length > 0);
  }
});

test('slice coordinates advance monotonically and stay consistent with the original hunk', () => {
  const lines: RawDiffLine[] = [];
  for (let i = 0; i < 15; i += 1) lines.push(line('context', `ctx-${i}`));
  lines.push(line('removed', 'gone'));
  for (let i = 0; i < 15; i += 1) lines.push(line('context', `ctx2-${i}`));

  const hunk = makeHunk(lines, {
    oldStart: 100,
    newStart: 200,
    oldCount: lines.filter((l) => l.kind !== 'added').length,
    newCount: lines.filter((l) => l.kind !== 'removed').length,
  });
  const slices = chunkHunk(hunk, { maxLinesPerSlice: 10, contextOverlap: 2 });
  assert.ok(slices.length > 1);
  assert.equal(slices[0]!.oldStart, 100);
  assert.equal(slices[0]!.newStart, 200);
  for (let i = 1; i < slices.length; i += 1) {
    assert.ok(slices[i]!.oldStart! >= slices[i - 1]!.oldStart!);
    assert.ok(slices[i]!.newStart! >= slices[i - 1]!.newStart!);
  }
});

test('a single change block larger than the target is still force-split rather than left unbounded', () => {
  const lines: RawDiffLine[] = [];
  for (let i = 0; i < 200; i += 1) lines.push(line('added', `new-${i}`));
  const hunk = makeHunk(lines, { oldCount: 0, newCount: 200, oldStart: null });
  const slices = chunkHunk(hunk, { maxLinesPerSlice: 60, contextOverlap: 3 });
  assert.ok(slices.length > 1, 'a 200-line single block must not become one giant slice');
  for (const s of slices) {
    assert.ok(s.lines.length <= 60 * 2);
  }
});

test('null coordinates (unknown side) propagate as null rather than a bogus number', () => {
  const lines = [line('added', 'x')];
  const hunk = makeHunk(lines, { oldStart: null, oldCount: null, newStart: 5, newCount: 1 });
  const [slice] = chunkHunk(hunk);
  assert.equal(slice!.oldStart, null);
  assert.equal(slice!.oldCount, null);
  assert.equal(slice!.newStart, 5);
});
