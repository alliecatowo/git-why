import assert from 'node:assert/strict';
import test from 'node:test';
import { messageOverlapBoost, OVERLAP_WEIGHT } from '../../../src/search/overlap.js';

test('no shared content words leaves the score exactly untouched', () => {
  assert.equal(messageOverlapBoost('why do we retry', 'Unrelated subject', 'Unrelated body'), 1);
});

test('full overlap reaches the ceiling, and nothing exceeds it', () => {
  const boost = messageOverlapBoost('retry backoff', 'retry backoff logic', '');
  assert.equal(boost, 1 + OVERLAP_WEIGHT);
  // Repeating a term must not compound: the measure is the fraction of the
  // question covered, not how often the commit says it.
  assert.equal(
    messageOverlapBoost('retry', 'retry retry retry', 'retry retry'),
    1 + OVERLAP_WEIGHT,
  );
});

test('partial overlap is proportional to the fraction of the question covered', () => {
  // Two content words, one matched.
  const boost = messageOverlapBoost('retry backoff', 'retry something else', '');
  assert.equal(boost, 1 + OVERLAP_WEIGHT * 0.5);
});

// The boost divides by the number of content words. A question made entirely
// of stop words has none, and a NaN score sorts unpredictably rather than
// failing loudly — so this is the identity, deliberately.
test('a question with no content words returns the identity, not NaN', () => {
  for (const question of ['what is it', 'why', '', '   ', 'the a an of to']) {
    const boost = messageOverlapBoost(question, 'any subject', 'any body');
    assert.equal(boost, 1, `expected identity for ${JSON.stringify(question)}`);
    assert.ok(Number.isFinite(boost));
  }
});

test('matching is case-insensitive', () => {
  assert.equal(
    messageOverlapBoost('Retry Backoff', 'retry backoff', ''),
    messageOverlapBoost('retry backoff', 'RETRY BACKOFF', ''),
  );
});

// `HTTP/3` in a question and `http3` in a commit are the same concept spelled
// two ways — prose uses the slash, code does not. A naive tokenizer scores
// that as a miss, which is exactly the vocabulary gap this tool exists to
// close, so the boost uses the same alphabet as the rest of retrieval.
test('a delimiter between letters and digits does not break the match', () => {
  assert.equal(messageOverlapBoost('HTTP/3 support', 'http3: add support', ''), 1 + OVERLAP_WEIGHT);
  assert.equal(messageOverlapBoost('http-2 push', 'http2 server push', ''), 1 + OVERLAP_WEIGHT);
});

test('the body counts, not only the subject', () => {
  // The reason a commit exists is usually in the body; a subject-only measure
  // would miss exactly the commits this tool is for.
  const subjectOnly = messageOverlapBoost('idempotency key', 'Add retry logic', '');
  const withBody = messageOverlapBoost(
    'idempotency key',
    'Add retry logic',
    'the endpoint has no idempotency key, so we queue instead',
  );
  assert.equal(subjectOnly, 1);
  assert.equal(withBody, 1 + OVERLAP_WEIGHT);
});

test('words too short to be evidence are ignored', () => {
  // The token pattern needs three characters, so single letters and pairs
  // cannot inflate a match.
  assert.equal(messageOverlapBoost('a of to', 'a of to', ''), 1);
});

test('the weight is a parameter, so it can be swept without editing the caller', () => {
  assert.equal(messageOverlapBoost('retry', 'retry', '', 0), 1);
  assert.equal(messageOverlapBoost('retry', 'retry', '', 3), 4);
});
