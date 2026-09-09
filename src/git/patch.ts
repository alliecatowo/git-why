/**
 * Explicit parsers for Git's machine-readable diff interfaces.
 *
 * Two separate Git invocations feed this module for one commit's diff against one
 * parent (or the empty tree):
 *
 *  - `diff-tree -r -z --raw --full-index -M -C <parent> <commit>` — authoritative,
 *    byte-exact change metadata (mode, blob OIDs, status, similarity, paths).
 *  - `diff-tree -p --no-color --no-ext-diff --no-textconv -U<n> <parent> <commit>` —
 *    the textual patch, used only for hunks.
 *
 * The two are correlated by ORDER (diff-tree emits both from the same underlying
 * diff queue, in the same sequence), never by re-parsing the human-readable
 * `diff --git a/... b/...` header, which Git can C-quote, truncate visually, or which
 * can coincidentally appear inside file content. Hunk extents are tracked by the
 * old/new line counts declared in each `@@ ... @@` header, so a content line that
 * happens to read `diff --git ...` is consumed as hunk content, never mistaken for a
 * new file boundary.
 */

import type { ChangeType } from '../types.js';

export interface RawChangeEntry {
  readonly oldMode: string | null;
  readonly newMode: string | null;
  readonly oldBlob: string | null;
  readonly newBlob: string | null;
  readonly changeType: ChangeType;
  readonly similarity: number | null;
  /** Null except on the delete side of a change (no path exists after it). */
  readonly oldPathBytes: Buffer | null;
  readonly newPathBytes: Buffer;
}

const ZERO_MODE = '000000';

function normalizeMode(raw: string): string | null {
  return raw === ZERO_MODE ? null : raw;
}

function isAllZero(sha: string): boolean {
  for (let i = 0; i < sha.length; i += 1) {
    if (sha[i] !== '0') return false;
  }
  return true;
}

function normalizeBlob(raw: string): string | null {
  return isAllZero(raw) ? null : raw;
}

function toChangeType(letter: string): ChangeType {
  switch (letter) {
    case 'A':
    case 'C':
    case 'D':
    case 'M':
    case 'R':
    case 'T':
    case 'U':
      return letter;
    default:
      return 'X';
  }
}

/** Parse the NUL-delimited output of `diff-tree -z --raw --full-index`. */
export function parseRawChanges(buf: Buffer): RawChangeEntry[] {
  const entries: RawChangeEntry[] = [];
  let i = 0;
  const n = buf.length;
  const COLON = 0x3a;
  const NUL = 0x00;
  while (i < n) {
    // Skip stray blank NULs some diff-tree modes emit between commits.
    while (i < n && buf[i] === NUL) i += 1;
    if (i >= n) break;
    if (buf[i] !== COLON) break; // defensive: unexpected leading byte, stop rather than misparse
    const metaEnd = buf.indexOf(NUL, i);
    if (metaEnd === -1) break;
    const meta = buf.toString('utf8', i, metaEnd);
    i = metaEnd + 1;
    // ":100644 100644 <oldsha> <newsha> R100" (fields are pure ASCII, safe to split on space)
    const fields = meta.slice(1).split(' ');
    const oldModeRaw = fields[0] ?? ZERO_MODE;
    const newModeRaw = fields[1] ?? ZERO_MODE;
    const oldBlobRaw = fields[2] ?? '';
    const newBlobRaw = fields[3] ?? '';
    const statusRaw = fields[4] ?? 'X';
    const changeType = toChangeType(statusRaw.charAt(0));
    const similarity = statusRaw.length > 1 ? Number.parseInt(statusRaw.slice(1), 10) : null;

    const path1End = buf.indexOf(NUL, i);
    if (path1End === -1) break;
    const path1 = buf.subarray(i, path1End);
    i = path1End + 1;

    let oldPathBytes: Buffer | null;
    let newPathBytes: Buffer;
    if (changeType === 'R' || changeType === 'C') {
      const path2End = buf.indexOf(NUL, i);
      if (path2End === -1) break;
      const path2 = buf.subarray(i, path2End);
      i = path2End + 1;
      oldPathBytes = path1;
      newPathBytes = path2;
    } else if (changeType === 'D') {
      oldPathBytes = null;
      newPathBytes = path1;
    } else {
      oldPathBytes = null;
      newPathBytes = path1;
    }

    entries.push({
      oldMode: normalizeMode(oldModeRaw),
      newMode: normalizeMode(newModeRaw),
      oldBlob: normalizeBlob(oldBlobRaw),
      newBlob: normalizeBlob(newBlobRaw),
      changeType,
      similarity,
      oldPathBytes,
      newPathBytes,
    });
  }
  return entries;
}

export type PatchLineKind = 'context' | 'add' | 'remove';

export interface PatchLine {
  readonly kind: PatchLineKind;
  /** Line content, excluding the leading marker and the line terminator. May keep a trailing `\r` (CRLF). */
  readonly text: string;
  /** True when Git's `\ No newline at end of file` marker followed this line. */
  readonly noNewline: boolean;
}

export interface ParsedHunk {
  readonly header: string;
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly lines: readonly PatchLine[];
}

export interface ParsedFileSection {
  /** Position of this file within the patch stream; correlates 1:1, in order, with `parseRawChanges`. */
  readonly index: number;
  readonly binary: boolean;
  readonly hunks: readonly ParsedHunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse the textual output of `diff-tree -p`. Never splits on a bare `diff --git` substring. */
export function parsePatchSections(buf: Buffer): ParsedFileSection[] {
  // Structural markers (`diff --git`, `@@ ... @@`, mode/index/rename headers) are always
  // pure ASCII in Git's own output, so a plain UTF-8 decode cannot corrupt them even if
  // some hunk body content is not valid UTF-8 (that content becomes lossy for display
  // only; byte-exact path/content identity comes from the raw `-z` metadata instead).
  const text = buf.toString('utf8');
  const lines = text.length === 0 ? [] : text.split('\n');

  const sections: ParsedFileSection[] = [];
  let current: ParsedFileSection | null = null;
  let hunks: ParsedHunk[] = [];
  let index = -1;

  const flush = (): void => {
    if (current !== null) {
      sections.push({ ...current, hunks });
    }
    current = null;
    hunks = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';

    if (line.startsWith('diff --git ')) {
      flush();
      index += 1;
      current = { index, binary: false, hunks: [] };
      i += 1;
      continue;
    }

    if (current === null) {
      i += 1;
      continue;
    }

    if (line.startsWith('Binary files ') && line.endsWith(' differ')) {
      current = { ...current, binary: true };
      i += 1;
      continue;
    }

    if (line === 'GIT binary patch') {
      current = { ...current, binary: true };
      i += 1;
      // Base85 literal/delta blocks, each terminated by a blank line; skip to the next
      // file section or EOF without trying to interpret binary patch content.
      while (i < lines.length && !(lines[i] ?? '').startsWith('diff --git ')) i += 1;
      continue;
    }

    const headerMatch = HUNK_HEADER.exec(line);
    if (headerMatch !== null) {
      const oldStart = Number(headerMatch[1]);
      const oldCount = headerMatch[2] !== undefined ? Number(headerMatch[2]) : 1;
      const newStart = Number(headerMatch[3]);
      const newCount = headerMatch[4] !== undefined ? Number(headerMatch[4]) : 1;
      const hunkLines: PatchLine[] = [];
      i += 1;
      let oldRemaining = oldCount;
      let newRemaining = newCount;
      while (i < lines.length && (oldRemaining > 0 || newRemaining > 0)) {
        const l = lines[i] ?? '';
        if (l.startsWith('\\')) {
          const last = hunkLines[hunkLines.length - 1];
          if (last !== undefined) hunkLines[hunkLines.length - 1] = { ...last, noNewline: true };
          i += 1;
          continue;
        }
        const marker = l.charAt(0);
        const rest = l.slice(1);
        if (marker === ' ') {
          hunkLines.push({ kind: 'context', text: rest, noNewline: false });
          oldRemaining -= 1;
          newRemaining -= 1;
        } else if (marker === '-') {
          hunkLines.push({ kind: 'remove', text: rest, noNewline: false });
          oldRemaining -= 1;
        } else if (marker === '+') {
          hunkLines.push({ kind: 'add', text: rest, noNewline: false });
          newRemaining -= 1;
        } else {
          // Malformed/unexpected input for real Git output; stop this hunk defensively
          // rather than misreading unrelated lines as content.
          break;
        }
        i += 1;
      }
      hunks.push({ header: line, oldStart, oldCount, newStart, newCount, lines: hunkLines });
      continue;
    }

    // Other header lines: `index ..`, `old mode`/`new mode`, `similarity index`,
    // `rename/copy from/to`, `--- a/..`, `+++ b/..`, `new file mode`, `deleted file mode`.
    // Paths are never read from here; identity comes from the raw `-z` metadata.
    i += 1;
  }
  flush();
  return sections;
}
