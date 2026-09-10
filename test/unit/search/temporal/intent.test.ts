import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  constraintFromFlags,
  decomposeQuery,
  parseAnchor,
} from '../../../../src/search/temporal/intent.js';
import { NO_TEMPORAL_CONSTRAINT } from '../../../../src/types.js';

/** Fixed clock so relative anchors ("last year") are deterministic. */
const NOW = Date.UTC(2026, 0, 15) as number;

test('a query with no temporal phrasing is left completely alone', () => {
  // This is the non-regression guarantee at its source. If the core differs
  // from the query by even a character, the embedded text changes and the
  // ranking of an ordinary query changes with it.
  const ordinary = [
    'why was the retry backoff changed',
    'auth refresh loop',
    'rate limiter',
    'why do we special-case empty access tokens',
    'connection pool exhaustion under load',
    'the parser rejects trailing commas',
  ];
  for (const query of ordinary) {
    const { core, constraint } = decomposeQuery(query, NOW);
    assert.equal(core, query, `core must be byte-identical for: ${query}`);
    assert.deepEqual(
      constraint,
      NO_TEMPORAL_CONSTRAINT,
      `constraint must be identity for: ${query}`,
    );
  }
});

test('introduction phrasing maps to first', () => {
  for (const q of [
    'when was HTTP/3 support first introduced',
    'when was the retry helper added',
    'when did we first add the cookie jar',
    'when did we start using the new client',
  ]) {
    const { constraint } = decomposeQuery(q, NOW);
    assert.equal(constraint.type, 'first', q);
    assert.equal(constraint.confidence, 'explicit', q);
  }
});

test('softer origin phrasing is inferred, not explicit', () => {
  // Being honest about confidence matters: `explicit` applies exponent 1.0,
  // so an over-eager classification does real damage to the ranking.
  for (const q of ['origin of the backoff constant', 'where did this magic number come from']) {
    const { constraint } = decomposeQuery(q, NOW);
    assert.equal(constraint.type, 'first', q);
    assert.equal(constraint.confidence, 'inferred', q);
  }
});

test('removal phrasing maps to removed and beats the first-introduction rules', () => {
  for (const q of [
    'when was the Safari cookie workaround removed',
    'why was the legacy tenant branch dropped',
    'when did we delete the v1 shim',
  ]) {
    const { constraint } = decomposeQuery(q, NOW);
    assert.equal(constraint.type, 'removed', q);
  }
});

test('last-change phrasing maps to last', () => {
  for (const q of [
    'when was the rate limiter last changed',
    'most recent change to the session store',
  ]) {
    assert.equal(decomposeQuery(q, NOW).constraint.type, 'last', q);
  }
});

test('history questions map to timeline, not to changed_when', () => {
  for (const q of [
    'history of the session refresh logic',
    'how did the retry policy evolve',
    'show me the evolution of the config loader',
  ]) {
    assert.equal(decomposeQuery(q, NOW).constraint.type, 'timeline', q);
  }
});

test('relative phrasing captures an anchor', () => {
  const before = decomposeQuery('retry logic before we migrated to the new client', NOW);
  assert.equal(before.constraint.type, 'before');
  assert.equal(before.constraint.anchor?.kind, 'query');

  const after = decomposeQuery('cookie handling since v2.0', NOW);
  assert.equal(after.constraint.type, 'after');
  assert.equal(after.constraint.anchor?.kind, 'tag');

  const between = decomposeQuery('tls changes between v1.0 and v2.0', NOW);
  assert.equal(between.constraint.type, 'between');
  assert.equal(between.constraint.anchor?.kind, 'tag');
  assert.equal(between.constraint.anchorEnd?.kind, 'tag');
});

test('the core drops temporal scaffolding but keeps the topic', () => {
  const { core } = decomposeQuery('when was HTTP/3 support first introduced', NOW);
  assert.match(core, /HTTP\/3/);
  assert.doesNotMatch(core, /\bfirst\b/i);
  assert.doesNotMatch(core, /\bintroduced\b/i);
  assert.doesNotMatch(core, /\bwhen\b/i);
});

test('the core never collapses to nothing', () => {
  // A query that is almost entirely temporal scaffolding would otherwise
  // strip to the empty string and retrieve noise.
  const { core } = decomposeQuery('when was it first added', NOW);
  assert.ok(core.length >= 3, `core was ${JSON.stringify(core)}`);
});

test('anchors parse to the right kind', () => {
  assert.equal(parseAnchor('2024-03-01', NOW).kind, 'date');
  assert.equal(parseAnchor('March 2024', NOW).kind, 'date');
  assert.equal(parseAnchor('v2.0', NOW).kind, 'tag');
  assert.equal(parseAnchor('1.18.30', NOW).kind, 'tag');
  assert.equal(parseAnchor('deadbeef', NOW).kind, 'sha');
  assert.equal(parseAnchor('we migrated to fetch', NOW).kind, 'query');

  const iso = parseAnchor('2024-03-01', NOW);
  assert.equal(iso.kind === 'date' ? iso.epochSeconds : null, Date.UTC(2024, 2, 1) / 1000);

  const relative = parseAnchor('last year', NOW);
  assert.equal(
    relative.kind === 'date' ? relative.epochSeconds : null,
    Math.floor(NOW / 1000) - 31556952,
  );
});

test('a four-digit number outside a plausible year range is not a date', () => {
  // 3000 in a query is far more likely a timeout constant than a year.
  assert.equal(parseAnchor('3000', NOW).kind, 'query');
});

test('flags always produce an explicit constraint, and beat the parser', () => {
  assert.equal(constraintFromFlags({ first: true }, NOW)?.type, 'first');
  assert.equal(constraintFromFlags({ first: true }, NOW)?.confidence, 'explicit');
  assert.equal(constraintFromFlags({ removed: true }, NOW)?.type, 'removed');
  assert.equal(constraintFromFlags({ timeline: true }, NOW)?.type, 'timeline');

  const between = constraintFromFlags({ between: ['v1.0', 'v2.0'] }, NOW);
  assert.equal(between?.type, 'between');
  assert.equal(between?.anchorEnd?.kind, 'tag');

  assert.equal(constraintFromFlags({}, NOW), null);
});
