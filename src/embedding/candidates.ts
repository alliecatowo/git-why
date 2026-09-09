/**
 * The registry of embedding candidates named in spec section 10: the
 * shipped default, plus the two other candidates the benchmark spike
 * compares it against. Only `loadDefaultEmbedder` is meant to be reachable
 * from the normal `git why` runtime path — the wiring layer (integrator's
 * `src/cli/wire.ts`) should import that function alone, not this whole
 * module's candidate list, so a benchmark run's extra candidates never
 * factor into an ordinary invocation's dependency or network footprint.
 *
 * Every identity below (model id, revision, file hashes) was captured by
 * hand against the live HuggingFace repos on 2026-09-09: `GET
 * /api/models/<id>` for the resolved commit sha, then `sha256sum` on the
 * downloaded `config.json` / `tokenizer.json` / `model.safetensors`. This
 * module never re-resolves "main" at runtime — see `src/embedding/cache.ts`
 * for why that matters (a newer upstream revision must never silently
 * substitute itself into a shipped default).
 */

import type { Embedder } from '../types.js';
import { GitWhyError } from '../types.js';
import { ensureCached, type PinnedArtifact } from './cache.js';
import type { CacheOptions } from './cache.js';
import { parseStaticModelConfig, StaticEmbedder } from './static-embedder.js';
import { readFile } from 'node:fs/promises';

/** minishlab/potion-code-16M-v2 — the shipped default. WordPiece, 256-dim, F16 weights, mean pooling, L2 normalized. */
export const POTION_CODE_16M_V2: PinnedArtifact = {
  modelId: 'minishlab/potion-code-16M-v2',
  revision: 'e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b',
  config: {
    filename: 'config.json',
    sha256: '148e5691a6fcc553437156859701fba017a1ba5d340b170f17e0f3668fb861a7',
  },
  tokenizer: {
    filename: 'tokenizer.json',
    sha256: '107bbdcbad4bff1d299b7a4c3a2fb17c52890688b7dd0e4c9deab79d3c4f3d45',
  },
  weights: {
    filename: 'model.safetensors',
    sha256: '75cf7a6c2171b230ad19b1e7d8e0b1aee86da5a02af8e7cacedd9921d227623c',
  },
};

/** minishlab/potion-retrieval-32M — prose-retrieval candidate, to test whether message-heavy history favors it. */
export const POTION_RETRIEVAL_32M: PinnedArtifact = {
  modelId: 'minishlab/potion-retrieval-32M',
  revision: '6fc8051fab2a1e0ee76689cf08c853792ac285e7',
  config: {
    filename: 'config.json',
    sha256: '63c00d90824c832c04ec1d02b6a983fb90489bf049f29fbff15ba481b8a432ee',
  },
  tokenizer: {
    filename: 'tokenizer.json',
    sha256: '7d75cbc54318138807c401b0f0c9721117c628b39de8e8e0edb6cb17e0ee7d18',
  },
  weights: {
    filename: 'model.safetensors',
    sha256: '07609e5bd33aad37900b3fd62f4ec96f6daec88ca4d46b9d8b928bfababf6ea0',
  },
};

export interface CandidateDescriptor {
  readonly name: string;
  readonly available: boolean;
  /** Populated when `available` is false. */
  readonly unavailableReason?: string;
  readonly pinned?: PinnedArtifact;
  /** Absent when `available` is false. Never called from the default CLI runtime path. */
  readonly createEmbedder?: (options?: CacheOptions) => Promise<Embedder>;
}

async function createGenericStaticEmbedder(
  pinned: PinnedArtifact,
  options: CacheOptions = {},
): Promise<Embedder> {
  const paths = await ensureCached(pinned, options);
  const [configJson, tokenizerJson, weightsBuffer] = await Promise.all([
    readFile(paths.configPath, 'utf8').then((s) => JSON.parse(s) as unknown),
    readFile(paths.tokenizerPath, 'utf8').then((s) => JSON.parse(s) as unknown),
    readFile(paths.weightsPath),
  ]);
  return new StaticEmbedder({
    modelId: pinned.modelId,
    revision: pinned.revision,
    config: parseStaticModelConfig(configJson),
    tokenizerJson,
    weightsBuffer,
    tokenizerSha256: pinned.tokenizer.sha256,
    weightsSha256: pinned.weights.sha256,
  });
}

/**
 * The one production path: load the shipped default embedder. This is the
 * only export of this module the CLI runtime should call.
 */
export async function loadDefaultEmbedder(options?: CacheOptions): Promise<Embedder> {
  return createGenericStaticEmbedder(POTION_CODE_16M_V2, options);
}

/**
 * A small locally supported MiniLM-class transformer, per spec section 10's
 * third candidate slot ("quality/startup reference"). Running an actual
 * transformer forward pass (as opposed to a static lookup-and-pool model)
 * needs either a JS-native ONNX/tensor runtime or a Python subprocess —
 * both are new runtime dependencies outside this project's budget
 * (`@zvec/zvec` + Node stdlib only). No such dependency has been added.
 * This candidate is therefore registered as unavailable, so the benchmark
 * can honestly report "not evaluated" instead of silently skipping it.
 */
const MINILM_UNAVAILABLE_REASON =
  'Running a real (non-static) MiniLM-class transformer requires an ONNX/tensor runtime or a Python subprocess, ' +
  'which is a new runtime dependency outside the @zvec/zvec + Node-stdlib budget. Not added; report this to the ' +
  'integrator if benchmark coverage of this candidate is required before the model decision is frozen.';

export const MODEL_CANDIDATES: readonly CandidateDescriptor[] = [
  {
    name: 'potion-code-16M-v2',
    available: true,
    pinned: POTION_CODE_16M_V2,
    createEmbedder: (options) => createGenericStaticEmbedder(POTION_CODE_16M_V2, options),
  },
  {
    name: 'potion-retrieval-32M',
    available: true,
    pinned: POTION_RETRIEVAL_32M,
    createEmbedder: (options) => createGenericStaticEmbedder(POTION_RETRIEVAL_32M, options),
  },
  {
    name: 'minilm-reference',
    available: false,
    unavailableReason: MINILM_UNAVAILABLE_REASON,
  },
];

/** Convenience for benchmark tooling: throws `MODEL_UNAVAILABLE` for a candidate marked unavailable. */
export async function createCandidateEmbedder(
  name: string,
  options?: CacheOptions,
): Promise<Embedder> {
  const candidate = MODEL_CANDIDATES.find((c) => c.name === name);
  if (!candidate) {
    throw new GitWhyError('MODEL_UNAVAILABLE', `unknown embedding candidate: ${name}`);
  }
  if (!candidate.available || !candidate.createEmbedder) {
    throw new GitWhyError(
      'MODEL_UNAVAILABLE',
      `candidate '${name}' is not evaluable in this environment: ${candidate.unavailableReason ?? 'unavailable'}`,
    );
  }
  return candidate.createEmbedder(options);
}
