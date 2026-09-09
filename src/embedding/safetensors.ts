/**
 * Minimal safetensors reader.
 *
 * Format: an 8-byte little-endian u64 header length, then that many bytes of
 * UTF-8 JSON describing each tensor's dtype/shape/byte range, then the raw
 * tensor bytes as one contiguous blob. See
 * https://github.com/huggingface/safetensors#format. No dependency beyond
 * `node:buffer` — this is the whole reason to hand-roll it rather than pull
 * in a package.
 *
 * Only what static Model2Vec inference needs is implemented: F32 tensors
 * read directly, F16/BF16 tensors converted to Float32Array on read (the
 * shipped model ships F16 weights; F32 is kept for candidates that don't).
 */

export interface TensorInfo {
  readonly dtype: string;
  readonly shape: readonly number[];
  /** Byte offsets into the data blob (not the file), half-open [start, end). */
  readonly dataOffsets: readonly [number, number];
}

export class SafetensorsFile {
  readonly tensors: ReadonlyMap<string, TensorInfo>;
  readonly metadata: Readonly<Record<string, string>> | null;
  private readonly buffer: Buffer;
  private readonly dataStart: number;

  // Node's unflagged TypeScript type-stripping (used to run tests directly)
  // rejects constructor parameter properties as non-erasable syntax, hence
  // the explicit field declarations and assignments here.
  private constructor(
    buffer: Buffer,
    dataStart: number,
    tensors: ReadonlyMap<string, TensorInfo>,
    metadata: Readonly<Record<string, string>> | null,
  ) {
    this.buffer = buffer;
    this.dataStart = dataStart;
    this.tensors = tensors;
    this.metadata = metadata;
  }

  static parse(buffer: Buffer): SafetensorsFile {
    if (buffer.length < 8) {
      throw new Error('safetensors: file too short to contain a header length');
    }
    const headerLen = buffer.readBigUInt64LE(0);
    if (headerLen < 0n || headerLen > BigInt(buffer.length - 8)) {
      throw new Error('safetensors: invalid header length');
    }
    const headerLenNum = Number(headerLen);
    const headerJson = buffer.toString('utf8', 8, 8 + headerLenNum);
    let header: Record<string, unknown>;
    try {
      header = JSON.parse(headerJson) as Record<string, unknown>;
    } catch (err) {
      throw new Error('safetensors: header is not valid JSON', { cause: err });
    }
    const dataStart = 8 + headerLenNum;
    const tensors = new Map<string, TensorInfo>();
    let metadata: Record<string, string> | null = null;
    for (const [key, value] of Object.entries(header)) {
      if (key === '__metadata__') {
        metadata = value as Record<string, string>;
        continue;
      }
      const v = value as { dtype: string; shape: number[]; data_offsets: [number, number] };
      tensors.set(key, { dtype: v.dtype, shape: v.shape, dataOffsets: v.data_offsets });
    }
    return new SafetensorsFile(buffer, dataStart, tensors, metadata);
  }

  has(name: string): boolean {
    return this.tensors.has(name);
  }

  /** Read a tensor of any supported dtype out as Float32Array, row-major. */
  getFloat32(name: string): Float32Array {
    const info = this.tensors.get(name);
    if (!info) {
      throw new Error(`safetensors: tensor not found: ${name}`);
    }
    const [start, end] = info.dataOffsets;
    const bytes = this.buffer.subarray(this.dataStart + start, this.dataStart + end);
    const elementSize = bytesPerElement(info.dtype);
    const expected = shapeCount(info.shape) * elementSize;
    if (bytes.length !== expected) {
      throw new Error(
        `safetensors: tensor ${name} byte range (${bytes.length}) does not match shape ${JSON.stringify(info.shape)} for dtype ${info.dtype}`,
      );
    }
    const count = bytes.length / elementSize;
    switch (info.dtype) {
      case 'F32':
        return readF32LE(bytes, count);
      case 'F16':
        return readF16LE(bytes, count);
      case 'BF16':
        return readBF16LE(bytes, count);
      default:
        throw new Error(`safetensors: unsupported dtype for ${name}: ${info.dtype}`);
    }
  }
}

function shapeCount(shape: readonly number[]): number {
  return shape.reduce((a, b) => a * b, 1);
}

function bytesPerElement(dtype: string): number {
  switch (dtype) {
    case 'F32':
      return 4;
    case 'F16':
    case 'BF16':
      return 2;
    default:
      throw new Error(`safetensors: unsupported dtype ${dtype}`);
  }
}

/** Copy into a view backed by a fresh, aligned buffer — `bytes` may not be 4-byte aligned in the source file. */
function dataViewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function readF32LE(bytes: Uint8Array, count: number): Float32Array {
  const view = dataViewOf(bytes);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

function readF16LE(bytes: Uint8Array, count: number): Float32Array {
  const view = dataViewOf(bytes);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = halfBitsToFloat32(view.getUint16(i * 2, true));
  return out;
}

/** IEEE 754 binary16 -> number. No native Node API for this. */
function halfBitsToFloat32(bits: number): number {
  const sign = (bits & 0x8000) >> 15;
  const exponent = (bits & 0x7c00) >> 10;
  const fraction = bits & 0x03ff;
  if (exponent === 0) {
    return (sign ? -1 : 1) * Math.pow(2, -14) * (fraction / 1024);
  }
  if (exponent === 0x1f) {
    return fraction ? NaN : sign ? -Infinity : Infinity;
  }
  return (sign ? -1 : 1) * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
}

function readBF16LE(bytes: Uint8Array, count: number): Float32Array {
  const src = dataViewOf(bytes);
  const out = new Float32Array(count);
  const scratch = new DataView(new ArrayBuffer(4));
  for (let i = 0; i < count; i++) {
    // bf16 is the top 16 bits of an f32 (truncated mantissa): left-shift into
    // the high half of a 32-bit word and decode as an ordinary float32.
    const bits = src.getUint16(i * 2, true) << 16;
    scratch.setUint32(0, bits, false);
    out[i] = scratch.getFloat32(0, false);
  }
  return out;
}
