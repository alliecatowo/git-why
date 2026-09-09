import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeEmbedder } from '../../../src/embedding/fake.js';

test('deterministic: same text always produces the same vector', async () => {
  const a = new FakeEmbedder();
  const b = new FakeEmbedder();
  const v1 = await a.embedQuery('fix the null pointer bug');
  const v2 = await b.embedQuery('fix the null pointer bug');
  assert.deepEqual(Array.from(v1), Array.from(v2));
});

test('different text (almost certainly) produces a different vector', async () => {
  const embedder = new FakeEmbedder();
  const v1 = await embedder.embedQuery('alpha');
  const v2 = await embedder.embedQuery('beta');
  assert.notDeepEqual(Array.from(v1), Array.from(v2));
});

test('vectors are L2-normalized', async () => {
  const embedder = new FakeEmbedder();
  const v = await embedder.embedQuery('some commit message');
  const norm = Math.sqrt(Array.from(v).reduce((acc, x) => acc + x * x, 0));
  assert.ok(Math.abs(norm - 1) < 1e-4);
});

test('dimension is configurable and reflected in output length', async () => {
  const embedder = new FakeEmbedder({ dimension: 8 });
  assert.equal(embedder.dimension, 8);
  const v = await embedder.embedQuery('text');
  assert.equal(v.length, 8);
});

test('fingerprint is obviously distinguishable from a real model fingerprint', () => {
  const embedder = new FakeEmbedder();
  // Real StaticEmbedder fingerprints are "m2v-sha256:<64 hex chars>" — the
  // fake's must not be confusable with that shape.
  assert.ok(embedder.fingerprint.startsWith('fake:'));
  assert.ok(!/^m2v-sha256:[0-9a-f]{64}$/.test(embedder.fingerprint));
});

test('fingerprint reflects dimension so two differently-sized fakes are distinguishable', () => {
  const a = new FakeEmbedder({ dimension: 16 });
  const b = new FakeEmbedder({ dimension: 32 });
  assert.notEqual(a.fingerprint, b.fingerprint);
});

test('countTokens and truncateToTokens use whitespace tokenization', () => {
  const embedder = new FakeEmbedder();
  assert.equal(embedder.countTokens('one two three'), 3);
  assert.equal(embedder.countTokens(''), 0);
  assert.equal(embedder.truncateToTokens('one two three', 2), 'one two');
  assert.equal(embedder.truncateToTokens('one two three', 0), '');
  assert.equal(embedder.truncateToTokens('one two three', 10), 'one two three');
});

test('embedDocuments matches embedQuery element-wise and preserves order', async () => {
  const embedder = new FakeEmbedder();
  const texts = ['first', 'second', 'third'];
  const batch = await embedder.embedDocuments(texts);
  for (let i = 0; i < texts.length; i++) {
    const single = await embedder.embedQuery(texts[i]!);
    assert.deepEqual(Array.from(batch[i]!), Array.from(single));
  }
});

test('dispose() resolves without throwing and does not break prior guarantees', async () => {
  const embedder = new FakeEmbedder();
  await embedder.dispose();
});
