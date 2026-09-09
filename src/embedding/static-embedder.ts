/**
 * Static Model2Vec inference: tokenize -> look up one embedding row per
 * token id -> mean-pool -> optionally scale by a per-token weight ->L2
 * normalize. No transformer forward pass; this is the entire model.
 *
 * Verified bit-for-bit (see test/integration/embedding/reference-vectors.test.ts)
 * against `minishlab/potion-code-16M-v2` run through the upstream Python
 * `model2vec` package (`StaticModel.encode`), reading its source
 * (`model2vec/model.py`, `StaticModel._encode_batch` / `_encode_helper`) to
 * confirm: ids come from the tokenizer with `add_special_tokens=False`, the
 * tokenizer's own configured truncation (512, from tokenizer.json) applies
 * first, then any token whose id is the model's `[UNK]` id is dropped
 * entirely (not embedded as an unknown vector), then the remaining rows are
 * meaned; an empty result (all tokens were UNK, or the input was empty)
 * yields the zero vector; normalization divides by `||v|| + 1e-32` (a
 * division that is a no-op except for guarding an exact all-zero input).
 * A "weights" tensor is applied per-token before the mean when present
 * (`model2vec/persistence/persistence.py` loads it as an optional sibling
 * tensor to "embeddings") — potion-code-16M-v2 has none (its Zipf weighting
 * was baked into the embedding matrix at distillation time), but
 * potion-retrieval-32M's format could in principle carry one, so it is
 * handled generically rather than assumed away.
 */

import { createHash } from 'node:crypto';
import type { Embedder } from '../types.js';
import { SafetensorsFile } from './safetensors.js';
import { loadTokenizer, type WordPieceTokenizer } from './tokenizer.js';

/** Static config fields Model2Vec's config.json may carry, read rather than assumed. */
export interface StaticModelConfig {
  readonly normalize: boolean;
  readonly embeddingDtype: string;
}

export function parseStaticModelConfig(json: unknown): StaticModelConfig {
  const raw = json as { normalize?: boolean; embedding_dtype?: string };
  return {
    normalize: raw.normalize ?? false,
    embeddingDtype: raw.embedding_dtype ?? 'float32',
  };
}

/** Everything needed to construct a `StaticEmbedder`, already loaded into memory. */
export interface StaticEmbedderArtifacts {
  readonly modelId: string;
  readonly revision: string;
  readonly config: StaticModelConfig;
  readonly tokenizerJson: unknown;
  readonly weightsBuffer: Buffer;
  /** sha256 of the exact bytes downloaded for the tokenizer file. */
  readonly tokenizerSha256: string;
  /** sha256 of the exact bytes downloaded for the weights file. */
  readonly weightsSha256: string;
}

const MAX_INPUT_TOKENS = 512;
const EMBEDDINGS_TENSOR_NAME = 'embeddings';
const WEIGHTS_TENSOR_NAME = 'weights';

function computeFingerprint(parts: {
  modelId: string;
  revision: string;
  weightsSha256: string;
  tokenizerSha256: string;
  pooling: string;
  normalization: string;
  dtype: string;
  dimension: number;
}): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(parts));
  return `m2v-sha256:${hash.digest('hex')}`;
}

export class StaticEmbedder implements Embedder {
  readonly fingerprint: string;
  readonly modelId: string;
  readonly revision: string;
  readonly dimension: number;
  readonly maxInputTokens: number = MAX_INPUT_TOKENS;

  private readonly tokenizer: WordPieceTokenizer;
  private readonly embeddings: Float32Array;
  private readonly weights: Float32Array | null;
  private readonly normalize: boolean;
  private disposed: boolean;

  constructor(artifacts: StaticEmbedderArtifacts) {
    this.modelId = artifacts.modelId;
    this.revision = artifacts.revision;
    this.tokenizer = loadTokenizer(artifacts.tokenizerJson);

    const tensors = SafetensorsFile.parse(artifacts.weightsBuffer);
    const embeddingInfo = tensors.tensors.get(EMBEDDINGS_TENSOR_NAME);
    if (!embeddingInfo) {
      throw new Error(`model.safetensors: no '${EMBEDDINGS_TENSOR_NAME}' tensor`);
    }
    if (embeddingInfo.shape.length !== 2) {
      throw new Error(`model.safetensors: '${EMBEDDINGS_TENSOR_NAME}' is not 2-D`);
    }
    const [vocabSize, dimension] = embeddingInfo.shape as [number, number];
    if (vocabSize !== this.tokenizer.vocabSize) {
      throw new Error(
        `model/tokenizer mismatch: embedding matrix has ${vocabSize} rows but tokenizer vocab has ${this.tokenizer.vocabSize} entries`,
      );
    }
    this.dimension = dimension;
    this.embeddings = tensors.getFloat32(EMBEDDINGS_TENSOR_NAME);
    this.weights = tensors.has(WEIGHTS_TENSOR_NAME)
      ? tensors.getFloat32(WEIGHTS_TENSOR_NAME)
      : null;

    this.normalize = artifacts.config.normalize;
    this.disposed = false;

    this.fingerprint = computeFingerprint({
      modelId: artifacts.modelId,
      revision: artifacts.revision,
      weightsSha256: artifacts.weightsSha256,
      tokenizerSha256: artifacts.tokenizerSha256,
      pooling: 'mean',
      normalization: this.normalize ? 'l2' : 'none',
      dtype: artifacts.config.embeddingDtype,
      dimension: this.dimension,
    });
  }

  countTokens(text: string): number {
    return this.tokenizer.countTokens(text);
  }

  truncateToTokens(text: string, maxTokens: number): string {
    return this.tokenizer.truncateToTokens(text, maxTokens);
  }

  async embedDocuments(texts: readonly string[]): Promise<Float32Array[]> {
    this.assertNotDisposed();
    return texts.map((text) => this.embedOne(text));
  }

  async embedQuery(text: string): Promise<Float32Array> {
    this.assertNotDisposed();
    return this.embedOne(text);
  }

   
  async dispose(): Promise<void> {
    this.disposed = true;
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error('StaticEmbedder used after dispose()');
    }
  }

  private embedOne(text: string): Float32Array {
    const raw = this.tokenizer.encode(text);
    // Mirror the tokenizer's own configured truncation (baked into
    // tokenizer.json as max_length: 512) before dropping UNK ids — this
    // ordering matters and is what model2vec's StaticModel.tokenize does.
    const truncated = raw.length > this.maxInputTokens ? raw.slice(0, this.maxInputTokens) : raw;
    const ids = truncated.filter((id) => id !== this.tokenizer.unkTokenId);

    const out = new Float32Array(this.dimension);
    if (ids.length === 0) {
      return out; // zero vector, matching model2vec's behaviour for empty token lists
    }
    for (const id of ids) {
      const rowOffset = id * this.dimension;
      const w = this.weights ? this.weights[id]! : 1;
      for (let d = 0; d < this.dimension; d++) {
        out[d]! += this.embeddings[rowOffset + d]! * w;
      }
    }
    for (let d = 0; d < this.dimension; d++) {
      out[d] = out[d]! / ids.length;
    }
    if (this.normalize) {
      let normSq = 0;
      for (let d = 0; d < this.dimension; d++) normSq += out[d]! * out[d]!;
      const norm = Math.sqrt(normSq) + 1e-32;
      for (let d = 0; d < this.dimension; d++) out[d] = out[d]! / norm;
    }
    return out;
  }
}
