/**
 * Fixed extraction-policy constants (spec #7, #9). These choices are part of the
 * repository snapshot's fingerprint, so changing any of them invalidates an index
 * generation rather than silently producing inconsistent records.
 */

import { createHash } from 'node:crypto';
import { EXTRACTION_POLICY_VERSION } from '../types.js';
import type { GitCapabilities } from './exec.js';

export const DIFF_CONTEXT_LINES = 3;
/** `histogram` is fast and gives good rename/move quality; recorded so a future change is versioned. */
export const DIFF_ALGORITHM = 'histogram';
export const RENAME_THRESHOLD_PERCENT = 50;
export const COPY_THRESHOLD_PERCENT = 50;
/** `-l` limit on rename/copy candidate pairs Git will consider. */
export const RENAME_LIMIT = 1000;
/** Parsed textual patch per commit, per spec #9. Beyond this the commit is pathological. */
export const PATCH_POLICY_BYTE_CAP = 2 * 1024 * 1024;

export function diffTreeRawArgs(): string[] {
  return [
    '-r',
    '-z',
    '--raw',
    '--full-index',
    `-M${RENAME_THRESHOLD_PERCENT}%`,
    `-C${COPY_THRESHOLD_PERCENT}%`,
    `-l${RENAME_LIMIT}`,
  ];
}

export function diffTreePatchArgs(): string[] {
  return [
    '-r',
    '-p',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    `-U${DIFF_CONTEXT_LINES}`,
    `--diff-algorithm=${DIFF_ALGORITHM}`,
    `--find-renames=${RENAME_THRESHOLD_PERCENT}%`,
    `--find-copies=${COPY_THRESHOLD_PERCENT}%`,
    `-l${RENAME_LIMIT}`,
  ];
}

/**
 * Fingerprint of the Git extraction configuration: everything about how we invoke and
 * constrain Git that could change what an already-indexed immutable commit extracts to.
 * Folded into `RepositorySnapshot.fingerprint` (spec #6).
 */
export function extractionConfigFingerprint(caps: GitCapabilities): string {
  const payload = JSON.stringify({
    extractionPolicyVersion: EXTRACTION_POLICY_VERSION,
    gitVersion: caps.version,
    diffContextLines: DIFF_CONTEXT_LINES,
    diffAlgorithm: DIFF_ALGORITHM,
    renameThreshold: RENAME_THRESHOLD_PERCENT,
    copyThreshold: COPY_THRESHOLD_PERCENT,
    renameLimit: RENAME_LIMIT,
    patchPolicyByteCap: PATCH_POLICY_BYTE_CAP,
    capabilities: {
      noReplaceObjects: caps.noReplaceObjects,
      noLazyFetch: caps.noLazyFetch,
      noOptionalLocks: caps.noOptionalLocks,
      noAdvice: caps.noAdvice,
      configPathOverride: caps.configPathOverride,
      attrSource: caps.attrSource,
    },
  });
  return createHash('sha256').update(payload).digest('hex');
}
