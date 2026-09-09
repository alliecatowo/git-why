import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileFtsQuery } from '../../../src/search/ftsquery.js';

test('identifier terms survive tokenization, whole and decomposed', () => {
  const compiled = compileFtsQuery('why does AuthSessionProvider loop?');
  const terms = compiled.split(' ');
  assert.ok(terms.includes('AuthSessionProvider'));
  assert.ok(terms.some((t) => t.toLowerCase() === 'session'));
});

test('numeric terms survive tokenization distinctly', () => {
  const compiled = compileFtsQuery('retry limit 13 vs 18');
  const terms = compiled.split(' ');
  assert.ok(terms.includes('13'));
  assert.ok(terms.includes('18'));
});

test('natural-language punctuation is stripped, not passed through as query syntax', () => {
  const compiled = compileFtsQuery('"auth" AND (session OR token)? -maybe:not');
  assert.ok(!compiled.includes('"'));
  assert.ok(!compiled.includes('('));
  assert.ok(!compiled.includes(')'));
  assert.ok(!compiled.includes('?'));
});

test('an empty query compiles to an empty string rather than throwing', () => {
  assert.equal(compileFtsQuery(''), '');
  assert.equal(compileFtsQuery('   '), '');
});

test('compileFtsQuery never emits queryString-style operator syntax such as field:value', () => {
  const compiled = compileFtsQuery('path:src/auth.ts AND status=done');
  // ":" and "=" are not identifier characters in our tokenizer, so they
  // are stripped as separators; the compiled text is safe to hand to a
  // literal matchString match, never a parsed queryString.
  assert.ok(!compiled.includes(':'));
  assert.ok(!compiled.includes('='));
});
