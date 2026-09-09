/**
 * Top-level orchestrator: turns the git lane's structural per-commit
 * material into a fully-formed `CommitExtraction` (a `CommitRecord` plus
 * its `EvidenceRecord`s), applying every history-lane policy in one place
 * -- ids, exclusion, chunking, the oversized-commit budget, and the
 * semantic/lexical text fields that the git lane leaves empty.
 *
 * `RawCommitInput`/`RawFileChange` are the documented git<->history
 * handoff contract (see `chunk.ts` for `RawHunk`): the git lane parses
 * `git log -p`/`git diff` machine output into these structural shapes and
 * calls `buildCommitExtraction`. They are not part of `src/types.ts`
 * because they are internal to this handoff, not a cross-cutting shared
 * type.
 *
 * Assumption (git-lane boundary): for a merge commit the git lane
 * resolves which single parent a hunk's diff is relative to (or omits
 * hunks entirely and reports `merge_hunks_omitted`) before calling here;
 * this module treats `parents[0]` as *the* parent for all evidence in one
 * commit and does not itself pick among parents.
 */
import {
  type ChangeType,
  type Coverage,
  type CommitExtraction,
  type CommitRecord,
  type EvidenceKind,
  type EvidenceRecord,
  type HistoricalPathChange,
  type OmissionReason,
  type Embedder,
} from '../types.js';
import { chunkHunk, type RawHunk, type HunkSlice, DEFAULT_CHUNK_OPTIONS } from './chunk.js';
import { classifyPathExclusion } from './exclusions.js';
import { commitDocId, evidenceDocId } from './ids.js';
import {
  MAX_CHANGED_PATHS_IN_SUMMARY,
  MAX_EMBEDDED_TOKENS_PER_COMMIT,
  MAX_SLICES_PER_COMMIT,
  MESSAGE_TEXT_MAX_BYTES,
  SOURCE_EXCERPT_MAX_BYTES,
  isPathologicalPatch,
} from './policy.js';
import { buildCommitText, buildHunkText, clipToBytes, type HunkTextInput } from './text.js';
import { selectSlicesWithinBudget, type CandidateFile } from './budget.js';

/**
 * Coverage the git lane discovers directly (a failed/truncated patch fetch,
 * a shallow boundary, a binary section, merge-hunk omission) that this
 * module does not itself detect. Additive only: unioned/summed into
 * whatever coverage this module computes for the same commit or file, never
 * replacing it. This is the one deliberate seam through which the git lane
 * hands coverage reasons it alone knows about into the records this module
 * builds.
 */
export interface GitDiscoveredCoverage {
  readonly reasons: readonly OmissionReason[];
  readonly unavailableFiles?: number;
  readonly failedFiles?: number;
  readonly excludedFiles?: number;
  readonly truncated?: boolean;
}

export interface RawFileChange {
  readonly change: HistoricalPathChange;
  /** Empty when there is no textual diff for this change (binary, mode-only, pure rename). */
  readonly hunks: readonly RawHunk[];
  /** Git-discovered coverage specific to this one file (e.g. `binary`). */
  readonly gitCoverage?: GitDiscoveredCoverage;
}

export interface RawCommitInput {
  readonly sha: string;
  readonly parents: readonly string[];
  readonly subject: string;
  readonly body: string;
  readonly author: { readonly name: string; readonly email: string; readonly time: number };
  readonly committerTime: number;
  readonly files: readonly RawFileChange[];
  /** Git-discovered coverage for the commit as a whole (e.g. `merge_hunks_omitted`, `shallow_boundary`). */
  readonly gitCoverage?: GitDiscoveredCoverage;
}

function coverageOf(reasons: readonly OmissionReason[], extra: Partial<Coverage> = {}): Coverage {
  const uniqueReasons = [...new Set(reasons)];
  return {
    complete: uniqueReasons.length === 0 && !(extra.truncated ?? false),
    reasons: uniqueReasons,
    excludedFiles: extra.excludedFiles ?? 0,
    unavailableFiles: extra.unavailableFiles ?? 0,
    failedFiles: extra.failedFiles ?? 0,
    truncated: extra.truncated ?? false,
  };
}

/**
 * Union a git-discovered coverage fragment into locally-computed reasons and
 * `Coverage` fields: reason lists are unioned, counts are summed, and
 * `truncated` is OR'd. `undefined` is a no-op.
 */
function mergeGitCoverage(
  reasons: readonly OmissionReason[],
  extra: Partial<Coverage>,
  git: GitDiscoveredCoverage | undefined,
): { reasons: readonly OmissionReason[]; extra: Partial<Coverage> } {
  if (git === undefined) return { reasons, extra };
  return {
    reasons: [...reasons, ...git.reasons],
    extra: {
      ...extra,
      excludedFiles: (extra.excludedFiles ?? 0) + (git.excludedFiles ?? 0),
      unavailableFiles: (extra.unavailableFiles ?? 0) + (git.unavailableFiles ?? 0),
      failedFiles: (extra.failedFiles ?? 0) + (git.failedFiles ?? 0),
      truncated: (extra.truncated ?? false) || (git.truncated ?? false),
    },
  };
}

/** Clip the retained message text to the policy byte budget, preferring to keep the subject intact. */
function clipMessageForRetention(
  subject: string,
  body: string,
  maxBytes: number,
): { subject: string; body: string; clipped: boolean } {
  const subjectBytes = Buffer.byteLength(subject, 'utf8');
  if (subjectBytes >= maxBytes) {
    const clippedSubject = clipToBytes(subject, maxBytes);
    return { subject: clippedSubject.text, body: '', clipped: true };
  }
  const clippedBody = clipToBytes(body, maxBytes - subjectBytes);
  return { subject, body: clippedBody.text, clipped: clippedBody.clipped };
}

const CHANGE_TYPE_NOTE: Record<ChangeType, string> = {
  A: 'File added',
  C: 'File copied',
  D: 'File deleted',
  M: 'File modified (no extracted textual diff)',
  R: 'File renamed',
  T: 'File type changed',
  U: 'File unmerged',
  X: 'File change of unknown type',
};

function buildFileChangeRecord(
  sha: string,
  parentSha: string | null,
  change: HistoricalPathChange,
  embedder: Embedder,
  subject: string,
  body: string,
  omissionReason: OmissionReason | null,
  gitCoverage?: GitDiscoveredCoverage,
): EvidenceRecord {
  const { reasons: mergedReasons, extra } = mergeGitCoverage(
    omissionReason === null ? [] : [omissionReason],
    {},
    gitCoverage,
  );
  const uniqueReasons = [...new Set(mergedReasons)];
  const input: HunkTextInput = {
    subject,
    body,
    path: change.path,
    oldPath: change.oldPath,
    changeType: change.changeType,
    removedLines: [],
    addedLines: uniqueReasons.map((r) => `(${r}: content omitted)`),
    contextLines: [CHANGE_TYPE_NOTE[change.changeType]],
  };
  const built = buildHunkText(input, embedder);
  return {
    type: 'evidence',
    kind: 'file_change',
    id: evidenceDocId({
      sha,
      parentSha,
      pathBytesBase64: change.path.bytesBase64,
      hunkOrdinal: null,
      sliceOrdinal: 0,
    }),
    sha,
    parentSha,
    path: change.path,
    oldPath: change.oldPath,
    changeType: change.changeType,
    hunkOrdinal: null,
    sliceOrdinal: 0,
    header: null,
    oldStart: null,
    oldCount: null,
    newStart: null,
    newCount: null,
    sourceExcerpt: '',
    semanticText: built.semanticText,
    lexicalText: built.lexicalText,
    coverage: coverageOf(uniqueReasons, extra),
  };
}

interface SliceCandidate {
  readonly change: HistoricalPathChange;
  readonly hunk: RawHunk;
  readonly slice: HunkSlice;
}

export function buildCommitExtraction(raw: RawCommitInput, embedder: Embedder): CommitExtraction {
  const parentSha = raw.parents[0] ?? null;
  const changedPaths = raw.files.map((f) => f.change);

  const clippedMessage = clipMessageForRetention(raw.subject, raw.body, MESSAGE_TEXT_MAX_BYTES);
  const commitText = buildCommitText(
    {
      subject: clippedMessage.subject,
      body: clippedMessage.body,
      changedPathDisplays: changedPaths.map((c) => c.path.display),
    },
    embedder,
    MAX_CHANGED_PATHS_IN_SUMMARY,
  );

  const totalPatchBytes = raw.files.reduce(
    (sum, f) => sum + f.hunks.reduce((s, h) => s + Buffer.byteLength(renderHunkForSizing(h), 'utf8'), 0),
    0,
  );
  const pathological = isPathologicalPatch(totalPatchBytes);

  const commitReasons: OmissionReason[] = [];
  if (clippedMessage.clipped) commitReasons.push('message_limit');
  if (changedPaths.length > MAX_CHANGED_PATHS_IN_SUMMARY) commitReasons.push('path_limit');
  if (pathological) commitReasons.push('pathological_commit');

  let excludedFiles = 0;

  const evidence: EvidenceRecord[] = [];

  if (pathological) {
    // Keep the summary and metadata; drop fine-grained extraction entirely.
    excludedFiles = raw.files.length;
  } else {
    const candidatesByPath = new Map<string, SliceCandidate[]>();

    for (const file of raw.files) {
      const { change } = file;
      const exclusion =
        classifyPathExclusion(change.path.display) ??
        (change.oldPath !== null ? classifyPathExclusion(change.oldPath.display) : null);

      if (exclusion !== null) {
        evidence.push(
          buildFileChangeRecord(
            raw.sha,
            parentSha,
            change,
            embedder,
            clippedMessage.subject,
            clippedMessage.body,
            exclusion,
            file.gitCoverage,
          ),
        );
        excludedFiles += 1;
        continue;
      }

      if (file.hunks.length === 0) {
        evidence.push(
          buildFileChangeRecord(
            raw.sha,
            parentSha,
            change,
            embedder,
            clippedMessage.subject,
            clippedMessage.body,
            null,
            file.gitCoverage,
          ),
        );
        continue;
      }

      const list: SliceCandidate[] = [];
      for (const hunk of file.hunks) {
        for (const slice of chunkHunk(hunk, DEFAULT_CHUNK_OPTIONS)) {
          list.push({ change, hunk, slice });
        }
      }
      candidatesByPath.set(change.path.display, list);
    }

    const paths = [...candidatesByPath.keys()];
    const candidateFiles: CandidateFile[] = paths.map((path) => ({
      path,
      slices: candidatesByPath.get(path)!.map((c) => ({
        tokenCount: embedder.countTokens(c.slice.sourceExcerpt),
      })),
    }));

    const selection = selectSlicesWithinBudget(candidateFiles, {
      maxSlices: MAX_SLICES_PER_COMMIT,
      maxTokens: MAX_EMBEDDED_TOKENS_PER_COMMIT,
    });

    if (selection.omittedFileCount > 0) excludedFiles += selection.omittedFileCount;
    for (const r of selection.reasons) commitReasons.push(r);

    for (const { fileIndex, sliceIndex } of selection.selected) {
      const path = paths[fileIndex]!;
      const candidate = candidatesByPath.get(path)![sliceIndex]!;
      const { change, slice } = candidate;

      const clippedExcerpt = clipToBytes(slice.sourceExcerpt, SOURCE_EXCERPT_MAX_BYTES);
      const removedLines = slice.lines.filter((l) => l.kind === 'removed').map((l) => l.text);
      const addedLines = slice.lines.filter((l) => l.kind === 'added').map((l) => l.text);
      const contextLines = slice.lines.filter((l) => l.kind === 'context').map((l) => l.text);

      const built = buildHunkText(
        {
          subject: clippedMessage.subject,
          body: clippedMessage.body,
          path: change.path,
          oldPath: change.oldPath,
          changeType: change.changeType,
          removedLines,
          addedLines,
          contextLines,
        },
        embedder,
      );

      const recordReasons: OmissionReason[] = [];
      if (clippedExcerpt.clipped) recordReasons.push('size_limit');
      if (built.semanticTruncated) recordReasons.push('token_budget');

      evidence.push({
        type: 'evidence',
        kind: 'hunk' satisfies EvidenceKind,
        id: evidenceDocId({
          sha: raw.sha,
          parentSha,
          pathBytesBase64: change.path.bytesBase64,
          hunkOrdinal: slice.hunkOrdinal,
          sliceOrdinal: slice.sliceOrdinal,
        }),
        sha: raw.sha,
        parentSha,
        path: change.path,
        oldPath: change.oldPath,
        changeType: change.changeType,
        hunkOrdinal: slice.hunkOrdinal,
        sliceOrdinal: slice.sliceOrdinal,
        header: slice.header,
        oldStart: slice.oldStart,
        oldCount: slice.oldCount,
        newStart: slice.newStart,
        newCount: slice.newCount,
        sourceExcerpt: clippedExcerpt.text,
        semanticText: built.semanticText,
        lexicalText: built.lexicalText,
        coverage: coverageOf(recordReasons, { truncated: recordReasons.length > 0 }),
      });
    }
  }

  const { reasons: finalCommitReasons, extra: finalCommitExtra } = mergeGitCoverage(
    commitReasons,
    {
      excludedFiles,
      truncated: commitReasons.length > 0 || commitText.semanticTruncated,
    },
    raw.gitCoverage,
  );

  const commit: CommitRecord = {
    type: 'commit',
    id: commitDocId(raw.sha),
    sha: raw.sha,
    parents: raw.parents,
    subject: raw.subject,
    body: raw.body,
    author: raw.author,
    committerTime: raw.committerTime,
    changedPaths,
    semanticText: commitText.semanticText,
    lexicalText: commitText.lexicalText,
    coverage: coverageOf(finalCommitReasons, finalCommitExtra),
  };

  return { commit, evidence };
}

function renderHunkForSizing(hunk: RawHunk): string {
  return hunk.lines.map((l) => l.text).join('\n');
}
