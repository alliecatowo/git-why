import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  quoteFilterLiteral,
  likeSubstringPattern,
  pathMatchKeys,
  buildEligibilityExpression,
} from '../../../src/index/filter.js';
import { NO_FILTERS } from '../../../src/types.js';

const FIELDS = {
  type: 'rtype',
  committerTime: 'committerTime',
  authorSearch: 'authorSearch',
  pathKeys: 'pathKeys',
};

test('quoteFilterLiteral picks the delimiter absent from the value', () => {
  assert.equal(quoteFilterLiteral('plain'), "'plain'");
  assert.equal(quoteFilterLiteral(`has'quote`), `"has'quote"`);
  assert.equal(quoteFilterLiteral('has"quote'), `'has"quote'`);
});

test('quoteFilterLiteral throws when both quote characters are present (no verified escape exists)', () => {
  assert.throws(() => quoteFilterLiteral(`both ' and " here`), /cannot safely quote/);
});

test('likeSubstringPattern escapes LIKE wildcards and the escape character itself', () => {
  assert.equal(likeSubstringPattern('100%sure'), `'%100\\%sure%'`);
  assert.equal(likeSubstringPattern('a_b'), `'%a\\_b%'`);
  assert.equal(likeSubstringPattern('back\\slash'), `'%back\\\\slash%'`);
});

test('pathMatchKeys includes the full path and every directory prefix', () => {
  assert.deepEqual(pathMatchKeys('src/index/collection.ts'), [
    'src/index/collection.ts',
    'src/index',
    'src',
  ]);
  assert.deepEqual(pathMatchKeys('README.md'), ['README.md']);
  assert.deepEqual(pathMatchKeys(''), []);
});

test('pathMatchKeys strips quote characters that would break a filter literal', () => {
  assert.deepEqual(pathMatchKeys(`weird'"path/file.ts`), ['weirdpath/file.ts', 'weirdpath']);
});

test('buildEligibilityExpression returns undefined when there is nothing to filter on', () => {
  assert.equal(buildEligibilityExpression(FIELDS, [], NO_FILTERS), undefined);
});

test('buildEligibilityExpression: single record type uses equality', () => {
  const expr = buildEligibilityExpression(FIELDS, ['commit'], NO_FILTERS);
  assert.equal(expr, `rtype = 'commit'`);
});

test('buildEligibilityExpression: multiple record types use IN', () => {
  const expr = buildEligibilityExpression(FIELDS, ['commit', 'evidence'], NO_FILTERS);
  assert.equal(expr, `rtype IN ('commit', 'evidence')`);
});

test('buildEligibilityExpression combines time range, author, and path restrictions with AND', () => {
  const expr = buildEligibilityExpression(FIELDS, ['commit'], {
    paths: [{ value: 'src/index', kind: 'directory' }],
    after: 100,
    before: 200,
    author: 'Ada',
  });
  assert.equal(
    expr,
    `rtype = 'commit' AND committerTime >= 100 AND committerTime < 200 AND authorSearch LIKE '%ada%' AND pathKeys CONTAIN_ANY('src/index')`,
  );
});

test('buildEligibilityExpression ORs multiple path restrictions via a single CONTAIN_ANY', () => {
  const expr = buildEligibilityExpression(FIELDS, [], {
    ...NO_FILTERS,
    paths: [
      { value: 'src/index', kind: 'directory' },
      { value: 'README.md', kind: 'file' },
    ],
  });
  assert.equal(expr, `pathKeys CONTAIN_ANY('src/index', 'README.md')`);
});
