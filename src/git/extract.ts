/**
 * The `HistoryExtractor`: trusts Git, parses its machine interfaces, and emits raw
 * structural material per commit (spec #7), then routes that material through
 * `buildCommitExtraction` (`src/history/extract.ts`) -- the retrieval lane's
 * documented join point -- which applies ids, exclusion, chunking, the oversized-
 * commit budget, and populates `semanticText`/`lexicalText`. This module owns
 * discovering Git-side coverage reasons (`shallow_boundary`, `missing_object`,
 * `merge_hunks_omitted`, `binary`, `pathological_commit`) and hands them to
 * `buildCommitExtraction` via the `gitCoverage` field on `RawCommitInput`/
 * `RawFileChange`, which merges them into the coverage it computes.
 *
 * Uses a small, bounded number of batched Git processes per refresh: one
 * `cat-file --batch` call for ALL requested commits' metadata, then a bounded pool of
 * per-commit `diff-tree` invocations (one for raw change metadata, one for the text
 * patch) for the diff evidence. This is the "bounded process pool per commit" the spec
 * calls an acceptable first correct implementation — not one invocation per field.
 */

import {
  type Embedder,
  type CommitExtraction,
  GitWhyError,
  type HistoricalPath,
  type HistoricalPathChange,
  type HistoryExtractor,
  type OmissionReason,
  type RepositoryIdentity,
  type RepositorySnapshot,
} from '../types.js';
import { runGit } from './exec.js';
import {
  type ParsedHunk,
  type PatchLine,
  type PatchLineKind,
  type RawChangeEntry,
  parsePatchSections,
  parseRawChanges,
} from './patch.js';
import { PATCH_POLICY_BYTE_CAP, diffTreePatchArgs, diffTreeRawArgs } from './policy.js';
import {
  buildCommitExtraction,
  type GitDiscoveredCoverage,
  type RawCommitInput,
  type RawFileChange,
} from '../history/extract.js';
import type { DiffLineKind, RawHunk } from '../history/chunk.js';

const CAT_FILE_MAX_BYTES = 512 * 1024 * 1024;
const RAW_DIFF_MAX_BYTES = 64 * 1024 * 1024;

/* ------------------------------------------------------------------ *
 * Commit object parsing (git cat-file --batch)
 * ------------------------------------------------------------------ */

interface ParsedCommit {
  readonly parents: readonly string[];
  readonly author: { readonly name: string; readonly email: string; readonly time: number };
  readonly committerTime: number;
  readonly subject: string;
  readonly body: string;
}

interface CatFileRecord {
  readonly type: string;
  readonly content: Buffer;
}

function parseCatFileBatch(buf: Buffer): Map<string, CatFileRecord | null> {
  const map = new Map<string, CatFileRecord | null>();
  let i = 0;
  while (i < buf.length) {
    const lineEnd = buf.indexOf(0x0a, i);
    if (lineEnd === -1) break;
    const header = buf.toString('utf8', i, lineEnd);
    i = lineEnd + 1;
    const missingMatch = /^(\S+) missing$/.exec(header);
    if (missingMatch?.[1] !== undefined) {
      map.set(missingMatch[1], null);
      continue;
    }
    const match = /^(\S+) (\S+) (\d+)$/.exec(header);
    if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) break;
    const [, oid, type, sizeStr] = match;
    const size = Number(sizeStr);
    const content = buf.subarray(i, i + size);
    i += size;
    if (buf[i] === 0x0a) i += 1;
    map.set(oid, { type, content: Buffer.from(content) });
  }
  return map;
}

function parsePersonLine(line: string | undefined): { name: string; email: string; time: number } {
  if (line === undefined) return { name: '', email: '', time: 0 };
  const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
    return { name: line, email: '', time: 0 };
  }
  return { name: match[1], email: match[2], time: Number(match[3]) };
}

function parseCommitObject(content: Buffer): ParsedCommit {
  const text = content.toString('utf8');
  const lines = text.split('\n');
  const parents: string[] = [];
  let authorLine: string | undefined;
  let committerLine: string | undefined;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line === '') {
      i += 1;
      break;
    }
    if (line.startsWith(' ')) {
      // Continuation of a multi-line header value (e.g. gpgsig). Not needed here.
      i += 1;
      continue;
    }
    const sp = line.indexOf(' ');
    const key = sp === -1 ? line : line.slice(0, sp);
    const value = sp === -1 ? '' : line.slice(sp + 1);
    if (key === 'parent') parents.push(value);
    else if (key === 'author') authorLine = value;
    else if (key === 'committer') committerLine = value;
    i += 1;
  }
  const message = lines.slice(i).join('\n');
  const nl = message.indexOf('\n');
  const subject = nl === -1 ? message : message.slice(0, nl);
  const body = nl === -1 ? '' : message.slice(nl + 1).replace(/^\n+/, '');
  const author = parsePersonLine(authorLine);
  const committer = parsePersonLine(committerLine);
  return { parents, author, committerTime: committer.time, subject, body };
}

async function batchCommitObjects(
  repository: RepositoryIdentity,
  shas: readonly string[],
): Promise<Map<string, ParsedCommit | null>> {
  const result = new Map<string, ParsedCommit | null>();
  if (shas.length === 0) return result;
  const input = Buffer.from(shas.join('\n') + '\n', 'utf8');
  const res = await runGit({
    gitDir: repository.commonDir,
    cwd: repository.commonDir,
    args: ['cat-file', '--batch'],
    input,
    maxBytes: CAT_FILE_MAX_BYTES,
  });
  if (res.code !== 0) {
    throw new GitWhyError('EXTRACTION_FAILED', `git cat-file --batch failed: ${res.stderr.toString('utf8').trim()}`);
  }
  if (res.truncatedStdout) {
    throw new GitWhyError('EXTRACTION_FAILED', 'git cat-file --batch output exceeded the memory cap');
  }
  const records = parseCatFileBatch(res.stdout);
  for (const sha of shas) {
    const record = records.get(sha);
    if (record === undefined || record === null || record.type !== 'commit') {
      result.set(sha, null);
      continue;
    }
    result.set(sha, parseCommitObject(record.content));
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Empty tree (never a hard-coded SHA-1 constant; SHA-256 repos differ)
 * ------------------------------------------------------------------ */

async function resolveEmptyTreeOid(repository: RepositoryIdentity): Promise<string> {
  const res = await runGit({
    gitDir: repository.commonDir,
    cwd: repository.commonDir,
    args: ['hash-object', '-t', 'tree', '/dev/null'],
  });
  if (res.code !== 0) {
    throw new GitWhyError('EXTRACTION_FAILED', `could not resolve the empty tree object: ${res.stderr.toString('utf8').trim()}`);
  }
  return res.stdout.toString('utf8').trim();
}

/* ------------------------------------------------------------------ *
 * Path conversion
 * ------------------------------------------------------------------ */

function toHistoricalPath(bytes: Buffer): HistoricalPath {
  const bytesBase64 = bytes.toString('base64');
  const display = bytes.toString('utf8');
  const roundTrip = Buffer.from(display, 'utf8');
  const lossy = !roundTrip.equals(bytes);
  return { bytesBase64, display, lossy };
}

function toHistoricalPathChange(raw: RawChangeEntry): HistoricalPathChange {
  return {
    path: toHistoricalPath(raw.newPathBytes),
    oldPath: raw.oldPathBytes === null ? null : toHistoricalPath(raw.oldPathBytes),
    changeType: raw.changeType,
    similarity: raw.similarity,
    oldMode: raw.oldMode,
    newMode: raw.newMode,
    oldBlob: raw.oldBlob,
    newBlob: raw.newBlob,
  };
}

function isSubmoduleEntry(raw: RawChangeEntry): boolean {
  return raw.oldMode === '160000' || raw.newMode === '160000';
}

/* ------------------------------------------------------------------ *
 * diff-tree invocations
 * ------------------------------------------------------------------ */

interface DiffResult {
  readonly ok: boolean;
  readonly stdout: Buffer;
  readonly truncated: boolean;
}

async function runDiffTreeRaw(repository: RepositoryIdentity, parent: string, sha: string): Promise<DiffResult> {
  const res = await runGit({
    gitDir: repository.commonDir,
    cwd: repository.commonDir,
    args: ['diff-tree', ...diffTreeRawArgs(), parent, sha],
    maxBytes: RAW_DIFF_MAX_BYTES,
  });
  return { ok: res.code === 0, stdout: res.stdout, truncated: res.truncatedStdout };
}

async function runDiffTreePatch(repository: RepositoryIdentity, parent: string, sha: string): Promise<DiffResult> {
  const res = await runGit({
    gitDir: repository.commonDir,
    cwd: repository.commonDir,
    args: ['diff-tree', ...diffTreePatchArgs(), parent, sha],
    maxBytes: PATCH_POLICY_BYTE_CAP,
  });
  return { ok: res.code === 0, stdout: res.stdout, truncated: res.truncatedStdout };
}

/* ------------------------------------------------------------------ *
 * Git lane -> history lane line/hunk mapping
 *
 * `PatchLine.kind` (this module's parser) and `DiffLineKind` (the history
 * lane's `RawHunk` contract, `src/history/chunk.ts`) are deliberately
 * different unions spelled by two independently-built lanes. Mapped
 * explicitly, exhaustively, and totally -- never by casting -- so a future
 * third spelling fails to compile here instead of silently mislabelling
 * evidence.
 * ------------------------------------------------------------------ */

function toDiffLineKind(kind: PatchLineKind): DiffLineKind {
  switch (kind) {
    case 'context':
      return 'context';
    case 'add':
      return 'added';
    case 'remove':
      return 'removed';
  }
}

function toRawHunk(change: HistoricalPathChange, hunkOrdinal: number, hunk: ParsedHunk): RawHunk {
  return {
    path: change.path,
    oldPath: change.oldPath,
    changeType: change.changeType,
    hunkOrdinal,
    header: hunk.header,
    oldStart: hunk.oldStart,
    oldCount: hunk.oldCount,
    newStart: hunk.newStart,
    newCount: hunk.newCount,
    lines: hunk.lines.map((l: PatchLine) => ({ kind: toDiffLineKind(l.kind), text: l.text })),
  };
}

/* ------------------------------------------------------------------ *
 * Per-commit raw material (fed into `buildCommitExtraction`)
 * ------------------------------------------------------------------ */

interface GitExtractedCommit {
  readonly raw: RawCommitInput;
  /** First-parent (or empty-tree, for a root) changed paths; empty only when no diff was obtainable at all. */
  readonly changedPaths: readonly HistoricalPathChange[];
}

async function extractOneCommit(
  repository: RepositoryIdentity,
  sha: string,
  parsed: ParsedCommit,
  emptyTreeOid: string,
  shallowBoundary: ReadonlySet<string>,
): Promise<GitExtractedCommit> {
  const isRoot = parsed.parents.length === 0;
  const isMerge = parsed.parents.length > 1;
  const diffParent = isRoot ? emptyTreeOid : (parsed.parents[0] as string);

  const base = {
    sha,
    parents: parsed.parents,
    subject: parsed.subject,
    body: parsed.body,
    author: parsed.author,
    committerTime: parsed.committerTime,
  };

  const raw = await runDiffTreeRaw(repository, diffParent, sha);
  if (!raw.ok) {
    // The parent (or the empty tree, which should never fail) is unavailable. A
    // missing parent is never treated as a root: message evidence we already have
    // from the commit object itself is retained, but there is no diff evidence.
    const reason: OmissionReason = shallowBoundary.has(sha) ? 'shallow_boundary' : 'missing_object';
    const reasons: OmissionReason[] = isMerge ? [reason, 'merge_hunks_omitted'] : [reason];
    return {
      raw: { ...base, files: [], gitCoverage: { reasons, unavailableFiles: 1 } },
      changedPaths: [],
    };
  }

  const rawEntries = parseRawChanges(raw.stdout);
  const changedPaths = rawEntries.map(toHistoricalPathChange);

  if (isMerge) {
    // No merge diff hunks in V1 (spec #7): metadata and first-parent changed paths
    // only, flagged with the documented coverage reason.
    const gitCoverage: GitDiscoveredCoverage = {
      reasons: ['merge_hunks_omitted'],
      excludedFiles: rawEntries.length,
    };
    return { raw: { ...base, files: [], gitCoverage }, changedPaths };
  }

  if (rawEntries.length === 0) {
    return { raw: { ...base, files: [] }, changedPaths };
  }

  const patch = await runDiffTreePatch(repository, diffParent, sha);
  if (!patch.ok) {
    // Should not normally happen once the raw call above succeeded; keep summary
    // metadata and record the omission rather than fabricating diff material.
    const reason: OmissionReason = shallowBoundary.has(sha) ? 'shallow_boundary' : 'missing_object';
    const gitCoverage: GitDiscoveredCoverage = { reasons: [reason], failedFiles: rawEntries.length };
    return { raw: { ...base, files: [], gitCoverage }, changedPaths };
  }

  if (patch.truncated) {
    const gitCoverage: GitDiscoveredCoverage = {
      reasons: ['pathological_commit'],
      failedFiles: rawEntries.length,
      truncated: true,
    };
    return { raw: { ...base, files: [], gitCoverage }, changedPaths };
  }

  const sections = parsePatchSections(patch.stdout);
  const files: RawFileChange[] = [];
  const commitLevelReasons: OmissionReason[] = [];

  for (let i = 0; i < rawEntries.length; i += 1) {
    const entry = rawEntries[i] as RawChangeEntry;
    const change = changedPaths[i] as HistoricalPathChange;
    const section = sections[i];

    if (isSubmoduleEntry(entry)) {
      // Never index the submodule's own objects; keep the gitlink OIDs as metadata.
      files.push({ change, hunks: [] });
      continue;
    }

    if (section === undefined) {
      // No corresponding patch section (defensive: should track 1:1 with raw entries).
      files.push({ change, hunks: [] });
      continue;
    }

    if (section.binary) {
      files.push({ change, hunks: [], gitCoverage: { reasons: ['binary'], excludedFiles: 1 } });
      if (!commitLevelReasons.includes('binary')) commitLevelReasons.push('binary');
      continue;
    }

    if (section.hunks.length === 0) {
      // Rename/copy/mode-only change with no textual hunk still yields file-change evidence.
      files.push({ change, hunks: [] });
      continue;
    }

    files.push({
      change,
      hunks: section.hunks.map((hunk, hunkOrdinal) => toRawHunk(change, hunkOrdinal, hunk)),
    });
  }

  return {
    raw: {
      ...base,
      files,
      gitCoverage: commitLevelReasons.length > 0 ? { reasons: commitLevelReasons } : undefined,
    },
    changedPaths,
  };
}

/* ------------------------------------------------------------------ *
 * Bounded-concurrency ordered map
 * ------------------------------------------------------------------ */

async function* mapWithOrderedConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): AsyncGenerator<R> {
  if (items.length === 0) return;
  const inFlight = new Map<number, Promise<R>>();
  const launch = (index: number): void => {
    const item = items[index] as T;
    inFlight.set(index, fn(item, index));
  };
  const initial = Math.min(limit, items.length);
  for (let i = 0; i < initial; i += 1) launch(i);
  let nextToLaunch = initial;
  for (let cursor = 0; cursor < items.length; cursor += 1) {
    const promise = inFlight.get(cursor);
    if (promise === undefined) continue;
    const result = await promise;
    inFlight.delete(cursor);
    if (nextToLaunch < items.length) {
      launch(nextToLaunch);
      nextToLaunch += 1;
    }
    yield result;
  }
}

/* ------------------------------------------------------------------ *
 * Public extractor
 * ------------------------------------------------------------------ */

const DEFAULT_CONCURRENCY = 6;

/**
 * Create a `HistoryExtractor` backed by real Git plumbing. `embedder` is used only
 * for its synchronous `countTokens`/`truncateToTokens` budgeting (via
 * `buildCommitExtraction`); nothing here calls `embedDocuments`.
 */
export function createGitHistoryExtractor(
  embedder: Embedder,
  concurrency: number = DEFAULT_CONCURRENCY,
): HistoryExtractor {
  return {
    async *extract(snapshot: RepositorySnapshot, shas: readonly string[]): AsyncIterable<CommitExtraction> {
      const repository = snapshot.repository;
      const shallowBoundary = new Set(snapshot.shallowBoundary);
      const [emptyTreeOid, commitObjects] = await Promise.all([
        resolveEmptyTreeOid(repository),
        batchCommitObjects(repository, shas),
      ]);

      yield* mapWithOrderedConcurrency(shas, concurrency, async (sha) => {
        const parsed = commitObjects.get(sha);
        if (parsed === undefined || parsed === null) {
          // The commit object itself is unavailable. There is nothing to build a
          // CommitRecord from (no subject/author to report); the caller's reachable-
          // commit enumeration should not normally produce such a sha.
          throw new GitWhyError('EXTRACTION_FAILED', `commit object unavailable for ${sha}`, {
            hint: 'this indicates the reachable-commit list included an object Git cannot read',
          });
        }
        const { raw, changedPaths } = await extractOneCommit(repository, sha, parsed, emptyTreeOid, shallowBoundary);
        const built = buildCommitExtraction(raw, embedder);
        // `buildCommitExtraction` derives `changedPaths` from `raw.files`, which this
        // module deliberately empties out for merge/failure/pathological commits (so
        // no evidence is fabricated for them) while still knowing the real first-parent
        // changed paths from the raw diff. Restore them here.
        return { commit: { ...built.commit, changedPaths }, evidence: built.evidence };
      });
    },
  };
}
