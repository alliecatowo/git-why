import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectSlicesWithinBudget, type CandidateFile } from '../../../src/history/budget.js';

function file(path: string, sliceCount: number, tokenCount = 10): CandidateFile {
  return { path, slices: Array.from({ length: sliceCount }, () => ({ tokenCount })) };
}

test('round-robin spreads selection across files instead of draining one file first', () => {
  const files = [file('src/a.ts', 5), file('src/b.ts', 5), file('src/c.ts', 5)];
  const result = selectSlicesWithinBudget(files, { maxSlices: 6, maxTokens: 1000 });
  assert.equal(result.selected.length, 6);
  // With 3 files and 6 total slices, round-robin means each file gets
  // exactly 2 -- never "5 from file a, 1 from file b".
  const perFile = new Map<number, number>();
  for (const s of result.selected) perFile.set(s.fileIndex, (perFile.get(s.fileIndex) ?? 0) + 1);
  assert.deepEqual([...perFile.values()].sort(), [2, 2, 2]);
});

test('a file with fewer slices than its fair share does not block other files from getting more', () => {
  const files = [file('src/a.ts', 1), file('src/b.ts', 5), file('src/c.ts', 5)];
  const result = selectSlicesWithinBudget(files, { maxSlices: 8, maxTokens: 1000 });
  assert.equal(result.selected.length, 8);
  const perFile = new Map<number, number>();
  for (const s of result.selected) perFile.set(s.fileIndex, (perFile.get(s.fileIndex) ?? 0) + 1);
  assert.equal(perFile.get(0), 1); // file a exhausted
  assert.equal((perFile.get(1) ?? 0) + (perFile.get(2) ?? 0), 7);
});

test('selection is deterministic: identical input always produces identical output', () => {
  const files = [file('z.ts', 4), file('a.ts', 4), file('m.ts', 4)];
  const a = selectSlicesWithinBudget(files, { maxSlices: 5, maxTokens: 1000 });
  const b = selectSlicesWithinBudget(files, { maxSlices: 5, maxTokens: 1000 });
  assert.deepEqual(a, b);
});

test('sorting by path means the fair-share round-robin still visits every file each round regardless of directory grouping', () => {
  const files = [
    file('test/a.spec.ts', 3),
    file('src/a.ts', 3),
    file('src/b.ts', 3),
    file('test/b.spec.ts', 3),
  ];
  const result = selectSlicesWithinBudget(files, { maxSlices: 4, maxTokens: 1000 });
  const touchedFiles = new Set(result.selected.map((s) => s.fileIndex));
  assert.equal(
    touchedFiles.size,
    4,
    'every file should get at least one slice before any gets a second',
  );
});

test('token budget stops selection even when the slice count budget is not exhausted', () => {
  const files = [file('a.ts', 3, 40), file('b.ts', 3, 40)];
  const result = selectSlicesWithinBudget(files, { maxSlices: 100, maxTokens: 100 });
  const totalTokens = result.selected.reduce(
    (sum, s) => sum + files[s.fileIndex]!.slices[s.sliceIndex]!.tokenCount,
    0,
  );
  assert.ok(totalTokens <= 100);
  assert.ok(result.omittedSliceCount > 0);
  assert.ok(result.reasons.includes('token_budget'));
});

test('slice-count budget is reported distinctly via slice_limit', () => {
  const files = [file('a.ts', 10, 1)];
  const result = selectSlicesWithinBudget(files, { maxSlices: 3, maxTokens: 1000 });
  assert.equal(result.selected.length, 3);
  assert.ok(result.reasons.includes('slice_limit'));
});

test('no omission is reported when everything fits', () => {
  const files = [file('a.ts', 2), file('b.ts', 2)];
  const result = selectSlicesWithinBudget(files, { maxSlices: 100, maxTokens: 1000 });
  assert.equal(result.omittedSliceCount, 0);
  assert.equal(result.omittedFileCount, 0);
  assert.deepEqual(result.reasons, []);
});
