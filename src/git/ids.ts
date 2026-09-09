/**
 * Deterministic document IDs (spec #8): a versioned, unambiguously length-framed tuple
 * of (record type, commit OID, parent OID, original path bytes, hunk ordinal, slice
 * ordinal), hashed with SHA-256. Framing avoids delimiter ambiguity from bytes in the
 * path; hashing avoids leaking the path or growing the ID with path length.
 *
 * This module is owned by the git lane and used only to populate `CommitRecord.id` /
 * `EvidenceRecord.id` inside `CommitExtraction`. The retrieval lane's own ID module
 * (`src/history/ids.ts`, referenced in the `src/types.ts` doc comment) is a separate
 * file; this one exists because `HistoryExtractor` in `src/types.ts` requires `id` to
 * already be populated on the records `extract()` yields, and the git lane may not
 * import from `src/history/`.
 */

import { createHash } from 'node:crypto';
import { DOC_ID_VERSION, type EvidenceKind } from '../types.js';

function frame(parts: readonly (string | number | null)[]): Buffer {
  const bufs: Buffer[] = [];
  for (const part of parts) {
    const bytes = part === null ? Buffer.alloc(0) : Buffer.from(String(part), 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(bytes.length, 0);
    bufs.push(len, bytes);
  }
  return Buffer.concat(bufs);
}

function digest(prefix: string, parts: readonly (string | number | null)[]): string {
  const hash = createHash('sha256').update(frame(parts)).digest('hex');
  return `${prefix}${DOC_ID_VERSION}_${hash}`;
}

/** ID for a commit's summary record. */
export function commitRecordId(sha: string): string {
  return digest('c', ['commit', sha, null, '', -1, -1]);
}

/** ID for one evidence record (a hunk slice, or a file-change with no textual hunk). */
export function evidenceRecordId(input: {
  readonly kind: EvidenceKind;
  readonly sha: string;
  readonly parentSha: string | null;
  readonly pathBytesBase64: string;
  readonly hunkOrdinal: number | null;
  readonly sliceOrdinal: number;
}): string {
  return digest('e', [
    input.kind,
    input.sha,
    input.parentSha,
    input.pathBytesBase64,
    input.hunkOrdinal ?? -1,
    input.sliceOrdinal,
  ]);
}
