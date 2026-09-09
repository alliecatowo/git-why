/**
 * Oversized-commit slice selection (spec section 9): for commits with more
 * candidate evidence than the per-commit budget allows, inspect
 * changed-file metadata first, prioritise a deterministic spread of files,
 * and round-robin across files before consuming the whole budget on one
 * file. No random sampling.
 *
 * Round-robin over a *deterministically sorted* file list is exactly what
 * "a deterministic spread of source and test files" amounts to: sorting by
 * path does not group all test files last and then truncate them away,
 * because every round of the loop visits every remaining file once before
 * any file gets a second slice. A file that runs out of slices simply
 * drops out of subsequent rounds; it never blocks another file's turn.
 */
import type { OmissionReason } from '../types.js';

export interface CandidateSlice {
  readonly tokenCount: number;
}

export interface CandidateFile {
  /** Normalised display path. Sorting key: must be stable and deterministic. */
  readonly path: string;
  readonly slices: readonly CandidateSlice[];
}

export interface SliceSelection {
  /** [fileIndex, sliceIndexWithinFile] pairs, in the order they should be embedded. */
  readonly selected: readonly { readonly fileIndex: number; readonly sliceIndex: number }[];
  readonly omittedSliceCount: number;
  readonly omittedFileCount: number;
  readonly reasons: readonly OmissionReason[];
}

export interface BudgetOptions {
  readonly maxSlices: number;
  readonly maxTokens: number;
}

/**
 * Deterministically select which slices to embed, round-robining across
 * files (sorted by path) until either budget is exhausted.
 */
export function selectSlicesWithinBudget(
  files: readonly CandidateFile[],
  opts: BudgetOptions,
): SliceSelection {
  const order = files
    .map((f, index) => ({ index, path: f.path }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.index - b.index))
    .map((f) => f.index);

  const nextSliceIndex = new Array(files.length).fill(0) as number[];
  const selected: { fileIndex: number; sliceIndex: number }[] = [];
  let totalTokens = 0;
  let totalSlices = 0;
  let totalAvailableSlices = 0;
  for (const f of files) totalAvailableSlices += f.slices.length;

  let progressed = true;
  let hitSliceLimit = false;
  let hitTokenBudget = false;
  while (progressed && totalSlices < opts.maxSlices) {
    progressed = false;
    for (const fileIndex of order) {
      if (totalSlices >= opts.maxSlices) {
        hitSliceLimit = true;
        break;
      }
      const file = files[fileIndex]!;
      const sIdx = nextSliceIndex[fileIndex]!;
      if (sIdx >= file.slices.length) continue;
      const slice = file.slices[sIdx]!;
      if (totalTokens + slice.tokenCount > opts.maxTokens) {
        hitTokenBudget = true;
        continue;
      }
      selected.push({ fileIndex, sliceIndex: sIdx });
      nextSliceIndex[fileIndex] = sIdx + 1;
      totalTokens += slice.tokenCount;
      totalSlices += 1;
      progressed = true;
    }
  }
  if (totalSlices >= opts.maxSlices) hitSliceLimit = true;

  const omittedSliceCount = totalAvailableSlices - selected.length;
  const filesFullyIncluded = files.filter((f, i) => nextSliceIndex[i] === f.slices.length).length;
  const omittedFileCount = files.length - filesFullyIncluded;

  const reasons: OmissionReason[] = [];
  if (omittedSliceCount > 0) {
    if (hitSliceLimit) reasons.push('slice_limit');
    if (hitTokenBudget) reasons.push('token_budget');
    if (reasons.length === 0) reasons.push('slice_limit');
  }

  return { selected, omittedSliceCount, omittedFileCount, reasons };
}
