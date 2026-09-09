import type { Embedder } from '../../../src/types.js';

/** Small, deterministic whitespace-tokenizer fake embedder for unit tests. */
export function makeFakeEmbedder(overrides: Partial<Embedder> = {}): Embedder {
  const dimension = 8;
  const maxInputTokens = overrides.maxInputTokens ?? 1024;

  function tokens(text: string): string[] {
    return text.split(/\s+/).filter((t) => t.length > 0);
  }

  const embedder: Embedder = {
    fingerprint: 'fake-embedder-v1',
    modelId: 'fake',
    revision: 'v1',
    dimension,
    maxInputTokens,
    countTokens(text: string): number {
      return tokens(text).length;
    },
    truncateToTokens(text: string, maxTokens: number): string {
      if (maxTokens <= 0) return '';
      const t = tokens(text);
      if (t.length <= maxTokens) return text;
      return t.slice(0, maxTokens).join(' ');
    },
    async embedDocuments(texts: readonly string[]): Promise<Float32Array[]> {
      return texts.map((t) => fakeVector(t, dimension));
    },
    async embedQuery(text: string): Promise<Float32Array> {
      return fakeVector(text, dimension);
    },
    async dispose(): Promise<void> {},
    ...overrides,
  };
  return embedder;
}

export function fakeVector(text: string, dim: number): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < text.length; i += 1) {
    v[i % dim] = (v[i % dim] ?? 0) + text.charCodeAt(i);
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i += 1) v[i] = (v[i] ?? 0) / norm;
  return v;
}
