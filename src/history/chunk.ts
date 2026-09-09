/**
 * Split oversized hunks at change-block or line boundaries into bounded
 * slices, carrying coordinates and a small amount of context, preserving
 * both deleted and added sides where possible.
 *
 * `RawHunk` is the documented handoff shape from the git extraction lane:
 * git parses `git diff`/`git log -p` machine output into structural hunks
 * (paths, coordinates, and classified lines) and leaves text/id/slicing
 * policy to this module -- it is not part of `src/types.ts` because it is
 * an internal contract between the git and history lanes, not a
 * cross-cutting shared type.
 */
import type { ChangeType, HistoricalPath } from '../types.js';

export type DiffLineKind = 'context' | 'removed' | 'added';

export interface RawDiffLine {
  readonly kind: DiffLineKind;
  /** Line content, without the leading ` `/`-`/`+` marker. */
  readonly text: string;
}

export interface RawHunk {
  readonly path: HistoricalPath;
  readonly oldPath: HistoricalPath | null;
  readonly changeType: ChangeType;
  readonly hunkOrdinal: number;
  readonly header: string | null;
  readonly oldStart: number | null;
  readonly oldCount: number | null;
  readonly newStart: number | null;
  readonly newCount: number | null;
  readonly lines: readonly RawDiffLine[];
}

export interface HunkSlice {
  readonly hunkOrdinal: number;
  readonly sliceOrdinal: number;
  readonly header: string | null;
  readonly oldStart: number | null;
  readonly oldCount: number | null;
  readonly newStart: number | null;
  readonly newCount: number | null;
  readonly lines: readonly RawDiffLine[];
  /** Faithful rendered unified-diff text for exactly this slice's lines. Unclipped. */
  readonly sourceExcerpt: string;
}

export interface ChunkOptions {
  /** Target maximum lines per slice (best-effort; a single oversized change block may exceed it). */
  readonly maxLinesPerSlice: number;
  /** Trailing context lines repeated at the start of the next slice for continuity. */
  readonly contextOverlap: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  maxLinesPerSlice: 60,
  contextOverlap: 3,
};

export function renderDiffLines(lines: readonly RawDiffLine[]): string {
  return lines
    .map((l) => `${l.kind === 'removed' ? '-' : l.kind === 'added' ? '+' : ' '}${l.text}`)
    .join('\n');
}

/**
 * A cut point is "safe" (does not sever a change block) only at a context
 * line, or at the very start/end of the line list.
 */
function isSafeCut(lines: readonly RawDiffLine[], index: number): boolean {
  if (index <= 0 || index >= lines.length) return true;
  return lines[index - 1]!.kind === 'context' || lines[index]!.kind === 'context';
}

interface Cursor {
  oldLine: number;
  newLine: number;
}

function advance(cursor: Cursor, line: RawDiffLine): void {
  if (line.kind === 'context') {
    cursor.oldLine += 1;
    cursor.newLine += 1;
  } else if (line.kind === 'removed') {
    cursor.oldLine += 1;
  } else {
    cursor.newLine += 1;
  }
}

function countSides(lines: readonly RawDiffLine[]): { oldCount: number; newCount: number } {
  let oldCount = 0;
  let newCount = 0;
  for (const l of lines) {
    if (l.kind !== 'added') oldCount += 1;
    if (l.kind !== 'removed') newCount += 1;
  }
  return { oldCount, newCount };
}

/**
 * Split a hunk into bounded slices. Boundaries prefer change-block edges
 * (a run of context lines); when a single removed/added run exceeds
 * `maxLinesPerSlice` on its own, it is force-split at a line boundary
 * rather than left unbounded. Each slice after the first repeats up to
 * `contextOverlap` trailing context lines from the previous slice so the
 * two sides of a change remain locally legible.
 */
export function chunkHunk(hunk: RawHunk, opts: ChunkOptions = DEFAULT_CHUNK_OPTIONS): HunkSlice[] {
  const { lines } = hunk;
  if (lines.length === 0) return [];

  if (lines.length <= opts.maxLinesPerSlice) {
    return [
      {
        hunkOrdinal: hunk.hunkOrdinal,
        sliceOrdinal: 0,
        header: hunk.header,
        oldStart: hunk.oldStart,
        oldCount: hunk.oldCount,
        newStart: hunk.newStart,
        newCount: hunk.newCount,
        lines,
        sourceExcerpt: renderDiffLines(lines),
      },
    ];
  }

  const slices: HunkSlice[] = [];
  const cursor: Cursor = { oldLine: hunk.oldStart ?? 1, newLine: hunk.newStart ?? 1 };
  let start = 0;
  let sliceOrdinal = 0;

  while (start < lines.length) {
    // Find the furthest safe end within budget, scanning forward from the
    // ideal boundary; if the ideal boundary itself isn't safe, extend
    // until a context line (or end of hunk) is reached so a change block
    // is never severed unless it alone exceeds the budget.
    let end = Math.min(start + opts.maxLinesPerSlice, lines.length);
    while (end < lines.length && !isSafeCut(lines, end)) end += 1;
    // Force-split an oversized single block that ran past a hard cap of
    // 2x the target, so one gigantic block cannot produce one gigantic slice.
    const hardCap = start + opts.maxLinesPerSlice * 2;
    if (end > hardCap) end = hardCap;

    const sliceLines = lines.slice(start, end);
    const { oldCount, newCount } = countSides(sliceLines);
    const oldStart = hunk.oldStart === null ? null : cursor.oldLine;
    const newStart = hunk.newStart === null ? null : cursor.newLine;

    slices.push({
      hunkOrdinal: hunk.hunkOrdinal,
      sliceOrdinal,
      header: hunk.header,
      oldStart,
      oldCount: hunk.oldStart === null ? null : oldCount,
      newStart,
      newCount: hunk.newStart === null ? null : newCount,
      lines: sliceLines,
      sourceExcerpt: renderDiffLines(sliceLines),
    });

    for (const l of sliceLines) advance(cursor, l);
    sliceOrdinal += 1;

    if (end >= lines.length) break;
    // Back off by the overlap so the next slice repeats trailing context.
    let nextStart = end;
    let overlapped = 0;
    while (
      nextStart > start &&
      overlapped < opts.contextOverlap &&
      lines[nextStart - 1]!.kind === 'context'
    ) {
      nextStart -= 1;
      overlapped += 1;
    }
    // Re-derive the cursor to account for any lines we backed the start up over.
    if (nextStart < end) {
      const backLines = lines.slice(nextStart, end);
      const back = countSides(backLines);
      if (hunk.oldStart !== null) cursor.oldLine -= back.oldCount;
      if (hunk.newStart !== null) cursor.newLine -= back.newCount;
    }
    start = nextStart;
  }

  return slices;
}
