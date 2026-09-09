/**
 * A deterministic, dependency-free `Embedder` for other lanes' unit tests.
 * No tokenizer file, no model weights, no network — just a hash spread
 * over a small vector space, so tests can assert "same text -> same
 * vector" and "different text -> (almost certainly) different vector"
 * without downloading anything.
 *
 * Not a quality stand-in for the real model: do not use this to draw any
 * conclusion about retrieval quality. Its only job is to satisfy the
 * `Embedder` contract cheaply and deterministically.
 */

import { createHash } from 'node:crypto';
import type { Embedder } from '../types.js';

const DEFAULT_DIMENSION = 32;
const DEFAULT_MAX_INPUT_TOKENS = 8192;

export interface FakeEmbedderOptions {
  readonly dimension?: number;
  readonly maxInputTokens?: number;
}

/** Whitespace tokenization — good enough for budgeting in tests that don't exercise the real tokenizer. */
function splitTokens(text: string): string[] {
  const trimmed = text.trim();
  return trimmed.length === 0 ? [] : trimmed.split(/\s+/);
}

function hashToUnitVector(text: string, dimension: number): Float32Array {
  const out = new Float32Array(dimension);
  // Expand a single sha256 digest into as many pseudo-random bytes as
  // needed by re-hashing with a counter suffix (a plain, unkeyed stretch —
  // this is a test fixture, not a cryptographic construction).
  let block = 0;
  let bytes: Buffer = Buffer.alloc(0);
  let byteIndex = 0;
  for (let d = 0; d < dimension; d++) {
    if (byteIndex >= bytes.length) {
      bytes = createHash('sha256').update(text).update(String(block)).digest();
      block++;
      byteIndex = 0;
    }
    // Map a byte pair to a signed float in [-1, 1).
    const hi = bytes[byteIndex++] ?? 0;
    const lo = bytes[byteIndex++] ?? 0;
    out[d] = ((hi << 8) | lo) / 32768 - 1;
  }
  let normSq = 0;
  for (let d = 0; d < dimension; d++) normSq += out[d]! * out[d]!;
  const norm = Math.sqrt(normSq) + 1e-12;
  for (let d = 0; d < dimension; d++) out[d] = out[d]! / norm;
  return out;
}

export class FakeEmbedder implements Embedder {
  readonly fingerprint: string;
  readonly modelId = 'git-why-fake-hash-embedder';
  readonly revision = 'n/a';
  readonly dimension: number;
  readonly maxInputTokens: number;

  constructor(options: FakeEmbedderOptions = {}) {
    this.dimension = options.dimension ?? DEFAULT_DIMENSION;
    this.maxInputTokens = options.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;
    // Deliberately shaped so it can never collide with a real model's
    // sha256 digest fingerprint: no real fingerprint starts with "fake:".
    this.fingerprint = `fake:git-why-fake-hash-embedder:dim=${this.dimension}`;
  }

  countTokens(text: string): number {
    return splitTokens(text).length;
  }

  truncateToTokens(text: string, maxTokens: number): string {
    if (maxTokens <= 0) return '';
    const tokens = splitTokens(text);
    if (tokens.length <= maxTokens) return text;
    return tokens.slice(0, maxTokens).join(' ');
  }

   
  async embedDocuments(texts: readonly string[]): Promise<Float32Array[]> {
    return texts.map((text) => hashToUnitVector(text, this.dimension));
  }

   
  async embedQuery(text: string): Promise<Float32Array> {
    return hashToUnitVector(text, this.dimension);
  }

   
  async dispose(): Promise<void> {
    // Nothing to release.
  }
}
