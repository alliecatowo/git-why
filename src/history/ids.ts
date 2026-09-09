/**
 * Deterministic document IDs.
 *
 * Every ID is the (possibly shortened) hex SHA-256 digest of a versioned,
 * explicitly framed byte tuple. "Framed" means every variable-length field
 * is preceded by a presence byte and, when present, a 4-byte big-endian
 * length -- so there is no delimiter a crafted commit message, path, or
 * ordinal could inject to make two distinct tuples hash identically. This
 * is deliberately not a six-character path hash and not an insertion
 * sequence: both leak information (path hashes partially disclose paths
 * via collision probing; sequences depend on iteration order) and neither
 * is reproducible from the record's own content alone.
 *
 * Never a delimiter-joined string. Never path bytes left unframed (a path
 * containing embedded framing-looking bytes must not be confusable with a
 * different path plus a different ordinal).
 */
import { createHash } from 'node:crypto';
import { DOC_ID_VERSION } from '../types.js';

/**
 * Full SHA-256 digests are 64 hex characters. Storage lane is empirically
 * probing Zvec's actual ID length/character constraints; if they report a
 * limit, change only `DOC_ID_HEX_LENGTH` (or pass an explicit `hexLength`
 * at call sites) -- the digest is computed once and merely sliced, so
 * shortening never changes the bytes of an unshortened ID's prefix.
 */
export const DOC_ID_HEX_LENGTH = 64;

export type DocRecordType = 'commit' | 'evidence';

export interface DocIdInput {
  readonly recordType: DocRecordType;
  readonly commitOid: string;
  readonly parentOid: string | null;
  /** Original path bytes (not the lossy display string). Null for a commit record. */
  readonly pathBytes: Uint8Array | null;
  readonly hunkOrdinal: number | null;
  readonly sliceOrdinal: number | null;
}

function u32be(n: number): Buffer {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
    throw new RangeError(`value out of u32 range for document ID framing: ${n}`);
  }
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(n, 0);
  return buf;
}

/** Presence byte (0x00 absent / 0x01 present) + explicit length + bytes. */
function frameBytes(bytes: Uint8Array | null): Buffer {
  if (bytes === null) return Buffer.from([0x00]);
  return Buffer.concat([Buffer.from([0x01]), u32be(bytes.length), Buffer.from(bytes)]);
}

function frameString(value: string | null): Buffer {
  return frameBytes(value === null ? null : Buffer.from(value, 'utf8'));
}

/** Presence byte + 4-byte value; distinct framing from strings so a numeric field can never be reinterpreted as a length-prefixed string. */
function frameOrdinal(value: number | null): Buffer {
  if (value === null) return Buffer.from([0x00]);
  return Buffer.concat([Buffer.from([0x01]), u32be(value)]);
}

function frame(input: DocIdInput): Buffer {
  return Buffer.concat([
    u32be(DOC_ID_VERSION),
    frameString(input.recordType),
    frameString(input.commitOid),
    frameString(input.parentOid),
    frameBytes(input.pathBytes),
    frameOrdinal(input.hunkOrdinal),
    frameOrdinal(input.sliceOrdinal),
  ]);
}

export function buildDocId(input: DocIdInput, hexLength: number = DOC_ID_HEX_LENGTH): string {
  const digest = createHash('sha256').update(frame(input)).digest('hex');
  if (hexLength <= 0 || hexLength > digest.length) {
    throw new RangeError(`hexLength must be between 1 and ${digest.length}`);
  }
  return digest.slice(0, hexLength);
}

export function commitDocId(sha: string, hexLength?: number): string {
  return buildDocId(
    {
      recordType: 'commit',
      commitOid: sha,
      parentOid: null,
      pathBytes: null,
      hunkOrdinal: null,
      sliceOrdinal: null,
    },
    hexLength,
  );
}

export interface EvidenceDocIdInput {
  readonly sha: string;
  readonly parentSha: string | null;
  /** Base64-encoded original path bytes, i.e. `HistoricalPath.bytesBase64`. */
  readonly pathBytesBase64: string;
  readonly hunkOrdinal: number | null;
  readonly sliceOrdinal: number;
}

export function evidenceDocId(input: EvidenceDocIdInput, hexLength?: number): string {
  return buildDocId(
    {
      recordType: 'evidence',
      commitOid: input.sha,
      parentOid: input.parentSha,
      pathBytes: Buffer.from(input.pathBytesBase64, 'base64'),
      hunkOrdinal: input.hunkOrdinal,
      sliceOrdinal: input.sliceOrdinal,
    },
    hexLength,
  );
}
