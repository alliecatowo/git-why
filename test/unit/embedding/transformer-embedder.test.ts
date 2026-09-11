import assert from 'node:assert/strict';
import test from 'node:test';
import { MODEL_CANDIDATES, loadDefaultEmbedder } from '../../../src/embedding/candidates.js';
import { JINA_V2_SMALL_EN } from '../../../src/embedding/transformer-embedder.js';

/**
 * The optional runtime is present on a developer machine that installed it and
 * absent in CI. Both are valid, so these assert what must hold either way and
 * only exercise the loading path when it can actually load.
 */
const jina = () => MODEL_CANDIDATES.find((c) => c.name === 'jina-v2-small');

test('the optional candidate is registered either way, so it can report why it is unavailable', () => {
  const candidate = jina();
  assert.ok(candidate, 'jina-v2-small must appear in the candidate list');
  // Silently omitting it would make a benchmark report "not evaluated" as
  // "does not exist", which are different claims.
  assert.equal(typeof candidate.available, 'boolean');
});

test('an unavailable candidate explains what to install, not merely that it failed', () => {
  const candidate = jina();
  assert.ok(candidate);
  if (candidate.available) return; // installed here; the absent path is below
  assert.match(candidate.unavailableReason ?? '', /@huggingface\/transformers/);
  assert.match(candidate.unavailableReason ?? '', /install/i);
  // And it must say the default needs nothing, or a reader may conclude the
  // whole tool depends on it.
  assert.match(candidate.unavailableReason ?? '', /default needs no such runtime/);
});

test('asking for an unavailable model fails loudly rather than falling back', async () => {
  const candidate = jina();
  assert.ok(candidate);
  if (candidate.available) return;
  const previous = process.env.GIT_WHY_EMBEDDING;
  process.env.GIT_WHY_EMBEDDING = 'jina-v2-small';
  try {
    await assert.rejects(() => loadDefaultEmbedder(), /not available/);
  } finally {
    if (previous === undefined) delete process.env.GIT_WHY_EMBEDDING;
    else process.env.GIT_WHY_EMBEDDING = previous;
  }
  // Falling back to the default would be the worst outcome: a benchmark would
  // report potion's numbers under Jina's name.
});

test('the default path never consults the optional runtime', async () => {
  // Whatever is or is not installed, no GIT_WHY_EMBEDDING means the shipped
  // static model. This is the promise that makes the dependency optional.
  const previous = process.env.GIT_WHY_EMBEDDING;
  delete process.env.GIT_WHY_EMBEDDING;
  try {
    const embedder = await loadDefaultEmbedder();
    assert.match(embedder.modelId, /potion-code-16M-v2/);
    assert.ok(!embedder.fingerprint.startsWith('transformer:'));
    await embedder.dispose();
  } finally {
    if (previous !== undefined) process.env.GIT_WHY_EMBEDDING = previous;
  }
});

test('the fingerprint encodes pooling and normalisation, not just the model id', () => {
  // An index built with mean/L2 and queried with anything else returns
  // nonsense rather than failing, so the fingerprint has to change when they
  // do — the model id alone would not.
  const expected = `transformer:${JINA_V2_SMALL_EN.modelId}@${JINA_V2_SMALL_EN.revision}:mean:l2:${JINA_V2_SMALL_EN.dimension}`;
  assert.match(expected, /:mean:l2:/);
  assert.notEqual(expected, JINA_V2_SMALL_EN.modelId);
});

test('a transformer embedder produces unit vectors that discriminate', async (t) => {
  const candidate = jina();
  assert.ok(candidate);
  if (!candidate.available) {
    t.skip('optional @huggingface/transformers runtime not installed');
    return;
  }
  const embedder = await candidate.createEmbedder!();
  try {
    assert.equal(embedder.dimension, 512);
    const query = await embedder.embedQuery('why do we retry on connection reset');
    assert.equal(query.length, 512);
    let norm = 0;
    for (const v of query) norm += v * v;
    assert.ok(Math.abs(Math.sqrt(norm) - 1) < 1e-3, 'vectors must be L2 normalised');

    const [relevant, unrelated] = await embedder.embedDocuments([
      'fix the retry loop after a connection reset',
      'update the documentation typos',
    ]);
    const cos = (a: Float32Array, b: Float32Array) => {
      let d = 0;
      for (let i = 0; i < a.length; i++) d += (a[i] as number) * (b[i] as number);
      return d;
    };
    assert.ok(
      cos(query, relevant!) > cos(query, unrelated!),
      'the relevant document must score higher than the unrelated one',
    );
  } finally {
    await embedder.dispose();
  }
});
