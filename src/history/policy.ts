/**
 * Versioned extraction policy constants (spec section 9). These are the
 * numbers that must be reported in the manifest (see `src/types.ts`,
 * `EXTRACTION_POLICY_VERSION`) so a future change to any of them is a
 * recorded, rebuild-triggering policy change rather than a silent drift.
 *
 * Bump `EXTRACTION_POLICY_VERSION` in `src/types.ts` (integrator-owned)
 * whenever a value here changes the set of records or text produced from
 * identical input.
 */

/** Semantic embedding input ceiling, before the embedder's own limit is applied. */
export const SEMANTIC_INPUT_MAX_TOKENS = 1024;

/**
 * At most this fraction of the semantic input budget may be spent on
 * repeated commit-message text, so a long commit message cannot crowd out
 * the code in a hunk's semantic text.
 */
export const SEMANTIC_MESSAGE_TEXT_FRACTION = 0.25;

/** Stored `EvidenceRecord.sourceExcerpt` ceiling, in UTF-8 bytes, per slice. */
export const SOURCE_EXCERPT_MAX_BYTES = 8 * 1024;

/** Commit message text retained for search (subject + body), in UTF-8 bytes. */
export const MESSAGE_TEXT_MAX_BYTES = 16 * 1024;

/** Parsed textual patch size, in bytes, before a commit is treated as pathological. */
export const PATCH_MAX_BYTES = 2 * 1024 * 1024;

/** Maximum number of evidence slices embedded per commit. */
export const MAX_SLICES_PER_COMMIT = 64;

/** Maximum total semantic-text input tokens embedded per commit, across all its slices. */
export const MAX_EMBEDDED_TOKENS_PER_COMMIT = 32768;

/** Maximum changed paths listed inside a commit's embedded semantic summary. */
export const MAX_CHANGED_PATHS_IN_SUMMARY = 128;

export function isPathologicalPatch(totalPatchBytes: number): boolean {
  return totalPatchBytes > PATCH_MAX_BYTES;
}

/** Effective semantic budget for a given embedder, honouring its own ceiling. */
export function semanticBudgetFor(embedderMaxInputTokens: number): number {
  return Math.min(embedderMaxInputTokens, SEMANTIC_INPUT_MAX_TOKENS);
}

export function messageTokenBudget(totalBudget: number): number {
  return Math.max(0, Math.floor(totalBudget * SEMANTIC_MESSAGE_TEXT_FRACTION));
}
