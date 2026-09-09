/**
 * Public surface of the embedding lane. The CLI wiring layer should import
 * only `loadDefaultEmbedder` (and, for tests, `FakeEmbedder`) — importing
 * `MODEL_CANDIDATES`/`createCandidateEmbedder` pulls in benchmark-only
 * identities that must never be reachable from a normal `git why` run.
 */

export { loadDefaultEmbedder, MODEL_CANDIDATES, createCandidateEmbedder, POTION_CODE_16M_V2, POTION_RETRIEVAL_32M } from './candidates.js';
export type { CandidateDescriptor } from './candidates.js';
export { FakeEmbedder } from './fake.js';
export type { FakeEmbedderOptions } from './fake.js';
export { StaticEmbedder, parseStaticModelConfig } from './static-embedder.js';
export type { StaticEmbedderArtifacts, StaticModelConfig } from './static-embedder.js';
export { ensureCached, resolveCacheRoot } from './cache.js';
export type { CacheOptions, CachedPaths, DownloadProgress, PinnedArtifact, PinnedFile, ProgressCallback } from './cache.js';
