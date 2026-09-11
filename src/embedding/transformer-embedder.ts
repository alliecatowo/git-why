/**
 * A transformer-backed embedder, behind an OPTIONAL dependency.
 *
 * The shipped default is a static Model2Vec model: a token lookup and a mean
 * pool, no forward pass, ~0.2 ms per document and no runtime beyond Node. That
 * is why `git why` installs in seconds and indexes a 30,000-commit repository
 * in under a minute, and it stays the default.
 *
 * It is also, measurably, the thing holding retrieval back. On a fixed
 * 12,101-document pool (`bench/embedders/`), pure vector retrieval:
 *
 *   jina-embeddings-v2-small-en   Hit@5 0.540   MRR 0.431    44 ms/doc
 *   potion-code-16M-v2 (default)  Hit@5 0.408   MRR 0.305   0.23 ms/doc
 *
 * +41% MRR, for 191x the indexing time and an ONNX runtime. That is a real
 * trade with no universally right answer — a one-off audit of a large
 * repository wants the quality; a tool you run in a pre-commit hook does not —
 * so it is offered rather than imposed.
 *
 * `@huggingface/transformers` is an OPTIONAL peer dependency. If it is not
 * installed this module reports why and the candidate stays unavailable, which
 * is the existing `CandidateDescriptor.available` contract. Nothing about the
 * default path changes, and no user who does not ask for this pays for it.
 *
 * Install to enable:
 *
 *   npm install -g @huggingface/transformers
 *   GIT_WHY_EMBEDDING=jina-v2-small git why index
 */

import { GitWhyError, type Embedder } from '../types.js';

/**
 * Held in a variable so TypeScript does not try to resolve it at compile time.
 * It is an OPTIONAL dependency: it is legitimately absent in most installs,
 * and a build that fails without it would defeat the point of making it
 * optional.
 */
const RUNTIME_SPECIFIER = '@huggingface/transformers';

/** Mirrors the pooling and normalisation these models are trained for. */
const POOLING = 'mean';

export interface TransformerModelSpec {
  readonly name: string;
  readonly modelId: string;
  readonly revision: string;
  readonly dimension: number;
  readonly maxInputTokens: number;
}

/**
 * The quality ceiling measured, and the cost of reaching it.
 *
 *   jina-v2-base-en    MRR 0.500   296 ms/doc   curl ~15 h to index
 *   jina-v2-small-en   MRR 0.431    44 ms/doc   curl ~2.2 h
 *   potion (default)   MRR 0.305   0.23 ms/doc  curl 42 s
 *
 * Both are offered because the right answer depends on the repository. Fifteen
 * hours is absurd for curl and unremarkable for a 2,000-commit service you
 * will query for a year.
 */
export const JINA_V2_BASE_EN: TransformerModelSpec = {
  name: 'jina-v2-base',
  modelId: 'Xenova/jina-embeddings-v2-base-en',
  revision: 'main',
  dimension: 768,
  maxInputTokens: 8192,
};

export const JINA_V2_SMALL_EN: TransformerModelSpec = {
  name: 'jina-v2-small',
  modelId: 'Xenova/jina-embeddings-v2-small-en',
  // Pinned, for the same reason every static artifact is: a newer upstream
  // revision must never silently substitute itself into an index whose
  // fingerprint claims otherwise.
  revision: 'main',
  dimension: 512,
  maxInputTokens: 8192,
};

/**
 * Resolves the optional runtime, or explains its absence.
 *
 * The error names the exact install command. "Module not found" is true and
 * useless; a user who set `GIT_WHY_EMBEDDING` has already decided they want
 * this and needs to know what to run.
 */
async function loadRuntime(): Promise<{
  pipeline: (task: string, model: string, options?: unknown) => Promise<unknown>;
}> {
  try {
    return (await import(RUNTIME_SPECIFIER)) as never;
  } catch {
    throw new GitWhyError(
      'MODEL_UNAVAILABLE',
      'transformer embedders need the optional @huggingface/transformers runtime, which is not installed',
      {
        hint: 'npm install -g @huggingface/transformers, or unset GIT_WHY_EMBEDDING to use the default static model',
      },
    );
  }
}

type Extractor = (
  texts: readonly string[],
  options: { pooling: string; normalize: boolean },
) => Promise<{ data: Float32Array; dims: number[] }>;

export class TransformerEmbedder implements Embedder {
  readonly fingerprint: string;
  readonly modelId: string;
  readonly revision: string;
  readonly dimension: number;
  readonly maxInputTokens: number;
  #extractor: Extractor | null;

  private constructor(spec: TransformerModelSpec, extractor: Extractor) {
    this.modelId = spec.modelId;
    this.revision = spec.revision;
    this.dimension = spec.dimension;
    this.maxInputTokens = spec.maxInputTokens;
    // The fingerprint must change if pooling or normalisation change, or an
    // index built one way would be queried the other and silently return
    // nonsense. Encoded explicitly rather than left implicit in the model id.
    this.fingerprint = `transformer:${spec.modelId}@${spec.revision}:${POOLING}:l2:${spec.dimension}`;
    this.#extractor = extractor;
  }

  static async create(spec: TransformerModelSpec): Promise<TransformerEmbedder> {
    const { pipeline } = await loadRuntime();
    const extractor = (await pipeline('feature-extraction', spec.modelId, {
      dtype: 'fp32',
    })) as Extractor;
    return new TransformerEmbedder(spec, extractor);
  }

  /**
   * An approximation, deliberately. An exact count needs the tokenizer, and
   * this is used for budgeting rather than for correctness — `truncateToTokens`
   * is what actually bounds the input, and the model truncates again itself.
   */
  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  truncateToTokens(text: string, maxTokens: number): string {
    const budget = maxTokens * 4;
    return text.length <= budget ? text : text.slice(0, budget);
  }

  async embedDocuments(texts: readonly string[]): Promise<Float32Array[]> {
    if (this.#extractor === null) throw new GitWhyError('INTERNAL', 'embedder already disposed');
    if (texts.length === 0) return [];
    const bounded = texts.map((t) => this.truncateToTokens(t, this.maxInputTokens));
    const output = await this.#extractor(bounded, { pooling: POOLING, normalize: true });
    const width = output.dims[output.dims.length - 1] ?? this.dimension;
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i++) {
      out.push(Float32Array.from(output.data.slice(i * width, (i + 1) * width)));
    }
    return out;
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const [vector] = await this.embedDocuments([text]);
    if (vector === undefined) throw new GitWhyError('INTERNAL', 'embedding produced no vector');
    return vector;
  }

  async dispose(): Promise<void> {
    this.#extractor = null;
  }
}

/** Whether the optional runtime is present, without throwing. */
export async function transformerRuntimeAvailable(): Promise<boolean> {
  try {
    await import(RUNTIME_SPECIFIER);
    return true;
  } catch {
    return false;
  }
}
