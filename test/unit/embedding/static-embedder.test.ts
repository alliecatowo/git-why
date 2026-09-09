// Unit coverage for src/embedding/static-embedder.ts's pooling and
// normalization arithmetic, against a tiny synthetic vocabulary/embedding
// matrix built in-memory (a 4-token, 3-dimensional model). This is the
// "verify pooling arithmetic on synthetic matrices" leg of verification;
// bit-for-bit agreement with the real model is checked separately in
// test/integration/embedding/reference-vectors.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StaticEmbedder, parseStaticModelConfig } from '../../../src/embedding/static-embedder.js';

// A 4-token vocabulary: [PAD]=0, [UNK]=1, "hello"=2, "world"=3.
// BertPreTokenizer + WordPiece on this vocab reduces to: known words map to
// their id, unknown words map to the UNK id.
const MINI_TOKENIZER = {
  model: {
    type: 'WordPiece',
    unk_token: '[UNK]',
    continuing_subword_prefix: '##',
    max_input_chars_per_word: 100,
    vocab: { '[PAD]': 0, '[UNK]': 1, hello: 2, world: 3 },
  },
  normalizer: { type: 'BertNormalizer', clean_text: true, handle_chinese_chars: true, strip_accents: null, lowercase: true },
  pre_tokenizer: { type: 'BertPreTokenizer' },
  post_processor: null,
};

const DIM = 3;
// Row per token id, in vocab order: [PAD], [UNK], hello, world.
const EMBEDDING_ROWS = [
  [0, 0, 0],
  [0, 0, 0],
  [1, 0, 0], // hello
  [0, 1, 0], // world
];

function buildWeightsBuffer(rows: number[][], extraTensors: Record<string, { dtype: string; shape: number[]; data: Buffer }> = {}): Buffer {
  const flat = rows.flat();
  const embData = Buffer.alloc(flat.length * 4);
  flat.forEach((v, i) => embData.writeFloatLE(v, i * 4));
  const header: Record<string, unknown> = {
    embeddings: { dtype: 'F32', shape: [rows.length, rows[0]!.length], data_offsets: [0, embData.length] },
  };
  const parts: Buffer[] = [embData];
  let offset = embData.length;
  for (const [name, t] of Object.entries(extraTensors)) {
    header[name] = { dtype: t.dtype, shape: t.shape, data_offsets: [offset, offset + t.data.length] };
    parts.push(t.data);
    offset += t.data.length;
  }
  const headerJson = Buffer.from(JSON.stringify(header), 'utf8');
  const headerLen = Buffer.alloc(8);
  headerLen.writeBigUInt64LE(BigInt(headerJson.length));
  return Buffer.concat([headerLen, headerJson, ...parts]);
}

function buildEmbedder(options: { normalize: boolean; weights?: number[] }): StaticEmbedder {
  const extra: Record<string, { dtype: string; shape: number[]; data: Buffer }> = {};
  if (options.weights) {
    const wData = Buffer.alloc(options.weights.length * 4);
    options.weights.forEach((v, i) => wData.writeFloatLE(v, i * 4));
    extra.weights = { dtype: 'F32', shape: [options.weights.length], data: wData };
  }
  const weightsBuffer = buildWeightsBuffer(EMBEDDING_ROWS, extra);
  return new StaticEmbedder({
    modelId: 'test/mini-model',
    revision: 'deadbeef',
    config: parseStaticModelConfig({ normalize: options.normalize, embedding_dtype: 'float32' }),
    tokenizerJson: MINI_TOKENIZER,
    weightsBuffer,
    tokenizerSha256: 'tok-hash',
    weightsSha256: 'weights-hash',
  });
}

test('mean-pools token rows without normalization', async () => {
  const embedder = buildEmbedder({ normalize: false });
  const vec = await embedder.embedQuery('hello world');
  // mean of [1,0,0] and [0,1,0] = [0.5, 0.5, 0]
  assert.deepEqual(Array.from(vec), [0.5, 0.5, 0]);
});

test('L2-normalizes when config.normalize is true', async () => {
  const embedder = buildEmbedder({ normalize: true });
  const vec = await embedder.embedQuery('hello world');
  const norm = Math.sqrt(vec[0]! ** 2 + vec[1]! ** 2 + vec[2]! ** 2);
  assert.ok(Math.abs(norm - 1) < 1e-6);
  assert.ok(Math.abs(vec[0]! - Math.SQRT1_2) < 1e-6);
  assert.ok(Math.abs(vec[1]! - Math.SQRT1_2) < 1e-6);
});

test('drops UNK tokens entirely rather than embedding an unknown-token vector', async () => {
  const embedder = buildEmbedder({ normalize: false });
  // "goodbye" is not in vocab -> UNK -> dropped. Only "hello" contributes.
  const vec = await embedder.embedQuery('hello goodbye');
  assert.deepEqual(Array.from(vec), [1, 0, 0]);
});

test('an all-UNK (or empty) input yields the exact zero vector', async () => {
  const embedder = buildEmbedder({ normalize: true }); // even with normalize on: 0/(0+eps) = 0
  const vec = await embedder.embedQuery('goodbye');
  assert.deepEqual(Array.from(vec), [0, 0, 0]);
  const vecEmpty = await embedder.embedQuery('');
  assert.deepEqual(Array.from(vecEmpty), [0, 0, 0]);
});

test('applies a per-token weights tensor before pooling when present', async () => {
  // weights: [PAD]=1, [UNK]=1, hello=2, world=0.5
  const embedder = buildEmbedder({ normalize: false, weights: [1, 1, 2, 0.5] });
  const vec = await embedder.embedQuery('hello world');
  // (hello*2 + world*0.5) / 2 tokens = ([2,0,0] + [0,0.5,0]) / 2 = [1, 0.25, 0]
  assert.deepEqual(Array.from(vec), [1, 0.25, 0]);
});

test('embedDocuments preserves order and matches embedQuery per element', async () => {
  const embedder = buildEmbedder({ normalize: false });
  const texts = ['hello', 'world', 'hello world', ''];
  const batch = await embedder.embedDocuments(texts);
  assert.equal(batch.length, texts.length);
  for (let i = 0; i < texts.length; i++) {
    const single = await embedder.embedQuery(texts[i]!);
    assert.deepEqual(Array.from(batch[i]!), Array.from(single));
  }
});

test('countTokens and truncateToTokens delegate to the tokenizer', () => {
  const embedder = buildEmbedder({ normalize: false });
  assert.equal(embedder.countTokens('hello world'), 2);
  assert.equal(embedder.truncateToTokens('hello world', 1), 'hello');
});

test('dimension is read from the embedding matrix shape', () => {
  const embedder = buildEmbedder({ normalize: false });
  assert.equal(embedder.dimension, DIM);
});

test('rejects a vocab/embedding-matrix size mismatch', () => {
  const badTokenizer = {
    ...MINI_TOKENIZER,
    model: { ...MINI_TOKENIZER.model, vocab: { '[PAD]': 0, '[UNK]': 1, hello: 2, world: 3, extra: 4 } },
  };
  const weightsBuffer = buildWeightsBuffer(EMBEDDING_ROWS); // still only 4 rows
  assert.throws(
    () =>
      new StaticEmbedder({
        modelId: 'test/mismatch',
        revision: 'x',
        config: parseStaticModelConfig({ normalize: false }),
        tokenizerJson: badTokenizer,
        weightsBuffer,
        tokenizerSha256: 'a',
        weightsSha256: 'b',
      }),
    /mismatch/,
  );
});

test('fingerprint changes when any input identity changes, and is stable otherwise', () => {
  const base = buildEmbedder({ normalize: false });
  const same = buildEmbedder({ normalize: false });
  assert.equal(base.fingerprint, same.fingerprint);

  const differentNormalization = buildEmbedder({ normalize: true });
  assert.notEqual(base.fingerprint, differentNormalization.fingerprint);

  const differentRevision = new StaticEmbedder({
    modelId: 'test/mini-model',
    revision: 'a-different-revision',
    config: parseStaticModelConfig({ normalize: false }),
    tokenizerJson: MINI_TOKENIZER,
    weightsBuffer: buildWeightsBuffer(EMBEDDING_ROWS),
    tokenizerSha256: 'tok-hash',
    weightsSha256: 'weights-hash',
  });
  assert.notEqual(base.fingerprint, differentRevision.fingerprint);

  const differentWeightsHash = new StaticEmbedder({
    modelId: 'test/mini-model',
    revision: 'deadbeef',
    config: parseStaticModelConfig({ normalize: false }),
    tokenizerJson: MINI_TOKENIZER,
    weightsBuffer: buildWeightsBuffer(EMBEDDING_ROWS),
    tokenizerSha256: 'tok-hash',
    weightsSha256: 'a-different-weights-hash',
  });
  assert.notEqual(base.fingerprint, differentWeightsHash.fingerprint);

  const differentTokenizerHash = new StaticEmbedder({
    modelId: 'test/mini-model',
    revision: 'deadbeef',
    config: parseStaticModelConfig({ normalize: false }),
    tokenizerJson: MINI_TOKENIZER,
    weightsBuffer: buildWeightsBuffer(EMBEDDING_ROWS),
    tokenizerSha256: 'a-different-tokenizer-hash',
    weightsSha256: 'weights-hash',
  });
  assert.notEqual(base.fingerprint, differentTokenizerHash.fingerprint);

  const differentModelId = new StaticEmbedder({
    modelId: 'test/a-different-model-id',
    revision: 'deadbeef',
    config: parseStaticModelConfig({ normalize: false }),
    tokenizerJson: MINI_TOKENIZER,
    weightsBuffer: buildWeightsBuffer(EMBEDDING_ROWS),
    tokenizerSha256: 'tok-hash',
    weightsSha256: 'weights-hash',
  });
  assert.notEqual(base.fingerprint, differentModelId.fingerprint);
});

test('dispose() causes subsequent use to throw', async () => {
  const embedder = buildEmbedder({ normalize: false });
  await embedder.dispose();
  await assert.rejects(() => embedder.embedQuery('hello'));
  await assert.rejects(() => embedder.embedDocuments(['hello']));
});
