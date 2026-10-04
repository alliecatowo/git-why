import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundedUniqueKeys, MAX_PATH_MATCH_KEYS } from '../../../src/index/collection.js';
import { pathMatchKeys } from '../../../src/history/pathkeys.js';

test('a commit touching more paths than the cap still matches every directory restriction', () => {
  const paths = Array.from({ length: 6000 }, (_, i) => `vendor/pkg${i % 50}/f${i}.js`);
  const keys = boundedUniqueKeys(paths.flatMap((p) => pathMatchKeys(p)));
  assert.equal(keys.length, MAX_PATH_MATCH_KEYS);
  const set = new Set(keys);
  assert.ok(set.has('vendor'));
  // First-N-in-diff-order used to drop every late package's directory key.
  for (let i = 0; i < 50; i++) assert.ok(set.has(`vendor/pkg${i}`));
});

test('under the cap nothing is dropped and order is preserved', () => {
  const keys = boundedUniqueKeys(['a', 'a/b', 'a/b/c.ts', 'a']);
  assert.deepEqual(keys, ['a', 'a/b', 'a/b/c.ts']);
});

test('path keys have quote characters stripped, matching how restrictions are queried', () => {
  assert.deepEqual(boundedUniqueKeys(["it's/dir", 'it\'s/dir/a"b.ts']), [
    'its/dir',
    'its/dir/ab.ts',
  ]);
});
