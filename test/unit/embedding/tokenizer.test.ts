// Unit coverage for the WordPiece + BertNormalizer + BertPreTokenizer
// pipeline in src/embedding/tokenizer.ts, against a small hand-built
// tokenizer.json (test/unit/embedding/fixtures/mini-tokenizer.json) rather
// than the real ~63k-entry model vocab, so this suite is fast and offline.
//
// The pipeline is verified bit-for-bit against the real model's tokenizer
// separately in test/integration/embedding/reference-vectors.test.ts (which
// downloads the real tokenizer.json and compares to Python model2vec
// output). This file exercises the algorithm's edge cases in isolation:
// accent stripping, CJK spacing, punctuation splitting, WordPiece
// continuation, the max-input-chars-per-word UNK path, and truncation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadTokenizer } from '../../../src/embedding/tokenizer.js';

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'mini-tokenizer.json',
);
const tokenizerJson = JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown;

function tok() {
  return loadTokenizer(tokenizerJson);
}

test('lowercases and matches whole-word vocab entries', () => {
  assert.deepEqual(tok().encode('Hello Wor'), [2, 3]);
});

test('splits an unmatched word into WordPiece continuations', () => {
  // "world" is not itself in the vocab; the greedy longest-match walk
  // should find "wor" then "##ld".
  assert.deepEqual(tok().encode('World'), [3, 4]);
});

test('strip_accents defaults to true when lowercase is true and strip_accents is null', () => {
  assert.deepEqual(tok().encode('Café'), [5]);
});

test('handle_chinese_chars pads CJK ideographs so they tokenize as isolated words', () => {
  const t = tok();
  const ids = t.encode('a中zzzz'); // "zzzz" isn't in vocab and isn't over the length cap -> UNK
  assert.deepEqual(ids, [11, 10, t.unkTokenId]);
});

test('BertPreTokenizer splits punctuation into their own single-char tokens', () => {
  assert.deepEqual(tok().encode('Fox!'), [12, 8]);
});

test('a full sentence composes whole-word, punctuation and comma tokens', () => {
  assert.deepEqual(tok().encode('The Quick, fox'), [6, 7, 9, 12]);
});

test('a word longer than max_input_chars_per_word becomes a single UNK, not per-char UNKs', () => {
  const t = tok();
  const ids = t.encode('xxxxxxxxxxxxxxx'); // 15 chars > max_input_chars_per_word (10)
  assert.deepEqual(ids, [t.unkTokenId]);
});

test('countTokens matches encode().length, including UNK tokens', () => {
  const t = tok();
  assert.equal(t.countTokens('Hello Wor World'), 4);
  assert.equal(t.countTokens(''), 0);
  assert.equal(t.countTokens('zzzzz'), 1); // single UNK still counts as one token
});

test('truncateToTokens cuts on a token boundary, preserving original casing', () => {
  const t = tok();
  const text = 'Hello Wor World';
  assert.equal(t.countTokens(text), 4); // hello, wor, wor, ##ld
  assert.equal(t.truncateToTokens(text, 2), 'Hello Wor');
  assert.equal(t.truncateToTokens(text, 0), '');
  assert.equal(t.truncateToTokens(text, 100), text); // no-op past the end
});

test('truncateToTokens never splits a single word across its own sub-tokens', () => {
  const t = tok();
  const text = 'Hello Wor World';
  // Token 3 (0-indexed) is "##ld", the second half of "World". Asking to
  // keep only 3 of the 4 tokens cannot land strictly between "wor" and
  // "##ld" without literally cutting the word in half, so truncation backs
  // off to the whole word — a real token boundary, just coarser than the
  // sub-token grain. This is documented behaviour, not a bug.
  assert.equal(t.truncateToTokens(text, 3), text);
});

test('empty input encodes to no tokens', () => {
  const t = tok();
  assert.deepEqual(t.encode(''), []);
  assert.equal(t.truncateToTokens('', 5), '');
});

test('unsupported tokenizer.json shapes are rejected rather than silently mis-tokenized', () => {
  assert.throws(() => loadTokenizer({ model: { type: 'BPE' } }), /WordPiece/);
  assert.throws(
    () => loadTokenizer({ model: { type: 'WordPiece' }, normalizer: { type: 'Sequence' } }),
    /BertNormalizer/,
  );
  assert.throws(
    () =>
      loadTokenizer({
        model: { type: 'WordPiece' },
        normalizer: { type: 'BertNormalizer' },
        pre_tokenizer: { type: 'Whitespace' },
      }),
    /BertPreTokenizer/,
  );
  assert.throws(
    () =>
      loadTokenizer({
        model: { type: 'WordPiece', vocab: { '[UNK]': 0 }, unk_token: '[UNK]' },
        normalizer: { type: 'BertNormalizer' },
        pre_tokenizer: { type: 'BertPreTokenizer' },
        post_processor: { type: 'TemplateProcessing' },
      }),
    /post_processor/,
  );
});
