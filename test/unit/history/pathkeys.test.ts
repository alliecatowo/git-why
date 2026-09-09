import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commitSummaryPathKeys, hunkPathKeys, pathMatchKeys } from '../../../src/history/pathkeys.js';
import type { HistoricalPath, HistoricalPathChange } from '../../../src/types.js';

function hp(display: string): HistoricalPath {
  return { bytesBase64: Buffer.from(display).toString('base64'), display, lossy: false };
}

test('pathMatchKeys returns every directory prefix plus the full path, full path last', () => {
  const keys = pathMatchKeys('src/auth/session.ts');
  assert.deepEqual(keys, ['src', 'src/auth', 'src/auth/session.ts']);
});

test('pathMatchKeys of a top-level file is just itself', () => {
  assert.deepEqual(pathMatchKeys('README.md'), ['README.md']);
});

test('commitSummaryPathKeys covers every changed path, old and new', () => {
  const changes: HistoricalPathChange[] = [
    {
      path: hp('src/auth/session.ts'),
      oldPath: null,
      changeType: 'M',
      similarity: null,
      oldMode: null,
      newMode: null,
      oldBlob: null,
      newBlob: null,
    },
    {
      path: hp('src/billing/invoice.ts'),
      oldPath: hp('src/billing/old_invoice.ts'),
      changeType: 'R',
      similarity: 90,
      oldMode: null,
      newMode: null,
      oldBlob: null,
      newBlob: null,
    },
  ];
  const keys = commitSummaryPathKeys(changes);
  assert.ok(keys.includes('src/auth/session.ts'));
  assert.ok(keys.includes('src/billing/invoice.ts'));
  assert.ok(keys.includes('src/billing/old_invoice.ts'));
  assert.ok(keys.includes('src'));
  assert.ok(keys.includes('src/auth'));
  assert.ok(keys.includes('src/billing'));
});

test('hunkPathKeys covers only its own path, not the commit sibling changes', () => {
  const keys = hunkPathKeys(hp('src/auth/session.ts'), null);
  assert.ok(keys.includes('src/auth/session.ts'));
  assert.ok(!keys.includes('src/billing/invoice.ts'));
});

test('hunkPathKeys for a rename covers both old and new path', () => {
  const keys = hunkPathKeys(hp('src/billing/invoice.ts'), hp('src/billing/old_invoice.ts'));
  assert.ok(keys.includes('src/billing/invoice.ts'));
  assert.ok(keys.includes('src/billing/old_invoice.ts'));
});

test('a commit-summary key set does not distinguish which hunk a path came from (that is the point of the asymmetry)', () => {
  // Two unrelated files in one commit: the summary's keys are the union,
  // so a `-- <path>` search on a *hunk* record (not the summary) is what
  // actually disambiguates which change matched.
  const changes: HistoricalPathChange[] = [
    {
      path: hp('src/a.ts'),
      oldPath: null,
      changeType: 'M',
      similarity: null,
      oldMode: null,
      newMode: null,
      oldBlob: null,
      newBlob: null,
    },
    {
      path: hp('src/b.ts'),
      oldPath: null,
      changeType: 'M',
      similarity: null,
      oldMode: null,
      newMode: null,
      oldBlob: null,
      newBlob: null,
    },
  ];
  const summaryKeys = commitSummaryPathKeys(changes);
  const hunkKeysForA = hunkPathKeys(hp('src/a.ts'), null);
  assert.ok(summaryKeys.includes('src/a.ts') && summaryKeys.includes('src/b.ts'));
  assert.ok(hunkKeysForA.includes('src/a.ts') && !hunkKeysForA.includes('src/b.ts'));
});
