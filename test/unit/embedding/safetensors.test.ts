// Unit coverage for src/embedding/safetensors.ts against hand-built
// buffers (the safetensors format is simple enough to construct by hand:
// an 8-byte LE header length, the JSON header, then raw tensor bytes).
// dtype conversion correctness (F16, BF16) is checked against known
// IEEE-754 bit patterns rather than a library, since the whole point of
// this module is to not depend on one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SafetensorsFile } from '../../../src/embedding/safetensors.js';

function buildSafetensors(
  tensors: Record<string, { dtype: string; shape: number[]; data: Buffer }>,
): Buffer {
  const header: Record<string, unknown> = {};
  const dataParts: Buffer[] = [];
  let offset = 0;
  for (const [name, t] of Object.entries(tensors)) {
    header[name] = {
      dtype: t.dtype,
      shape: t.shape,
      data_offsets: [offset, offset + t.data.length],
    };
    dataParts.push(t.data);
    offset += t.data.length;
  }
  const headerJson = Buffer.from(JSON.stringify(header), 'utf8');
  const headerLen = Buffer.alloc(8);
  headerLen.writeBigUInt64LE(BigInt(headerJson.length));
  return Buffer.concat([headerLen, headerJson, ...dataParts]);
}

test('reads an F32 tensor back exactly', () => {
  const values = [1.5, -2.25, 0, 3.0];
  const data = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => data.writeFloatLE(v, i * 4));
  const buf = buildSafetensors({ w: { dtype: 'F32', shape: [2, 2], data } });
  const file = SafetensorsFile.parse(buf);
  assert.deepEqual(Array.from(file.getFloat32('w')), values);
});

test('converts F16 bit patterns to the correct float32 values', () => {
  // Known IEEE-754 binary16 patterns: 0x3C00 = 1.0, 0xC000 = -2.0, 0x0000 = 0.0, 0x3555 ~= 0.333.
  const bits = [0x3c00, 0xc000, 0x0000, 0x3555];
  const data = Buffer.alloc(bits.length * 2);
  bits.forEach((b, i) => data.writeUInt16LE(b, i * 2));
  const buf = buildSafetensors({ w: { dtype: 'F16', shape: [4], data } });
  const file = SafetensorsFile.parse(buf);
  const out = file.getFloat32('w');
  assert.equal(out[0], 1.0);
  assert.equal(out[1], -2.0);
  assert.equal(out[2], 0.0);
  assert.ok(Math.abs(out[3]! - 0.333) < 0.001);
});

test('converts BF16 bit patterns to the correct float32 values', () => {
  // BF16 is the top 16 bits of the IEEE-754 float32 bit pattern.
  // float32 1.0 = 0x3F800000 -> bf16 top half = 0x3F80.
  // float32 -2.0 = 0xC0000000 -> bf16 top half = 0xC000.
  const bits = [0x3f80, 0xc000, 0x0000];
  const data = Buffer.alloc(bits.length * 2);
  bits.forEach((b, i) => data.writeUInt16LE(b, i * 2));
  const buf = buildSafetensors({ w: { dtype: 'BF16', shape: [3], data } });
  const file = SafetensorsFile.parse(buf);
  const out = file.getFloat32('w');
  assert.equal(out[0], 1.0);
  assert.equal(out[1], -2.0);
  assert.equal(out[2], 0.0);
});

test('reads multiple tensors from one buffer at their correct offsets', () => {
  const aData = Buffer.alloc(8);
  aData.writeFloatLE(1, 0);
  aData.writeFloatLE(2, 4);
  const bData = Buffer.alloc(4);
  bData.writeFloatLE(9, 0);
  const buf = buildSafetensors({
    a: { dtype: 'F32', shape: [2], data: aData },
    b: { dtype: 'F32', shape: [1], data: bData },
  });
  const file = SafetensorsFile.parse(buf);
  assert.deepEqual(Array.from(file.getFloat32('a')), [1, 2]);
  assert.deepEqual(Array.from(file.getFloat32('b')), [9]);
  assert.equal(file.has('a'), true);
  assert.equal(file.has('missing'), false);
});

test('rejects a shape/byte-range mismatch rather than silently misreading', () => {
  const data = Buffer.alloc(4); // one F32 element
  const buf = buildSafetensors({ w: { dtype: 'F32', shape: [2, 2], data } }); // claims 4 elements
  const file = SafetensorsFile.parse(buf);
  assert.throws(() => file.getFloat32('w'), /byte range/);
});

test('throws for a tensor name that does not exist', () => {
  const data = Buffer.alloc(4);
  const buf = buildSafetensors({ w: { dtype: 'F32', shape: [1], data } });
  const file = SafetensorsFile.parse(buf);
  assert.throws(() => file.getFloat32('nope'), /not found/);
});

test('throws for an unsupported dtype', () => {
  const data = Buffer.alloc(8);
  const buf = buildSafetensors({ w: { dtype: 'I64', shape: [1], data } });
  const file = SafetensorsFile.parse(buf);
  assert.throws(() => file.getFloat32('w'), /unsupported dtype/);
});

test('rejects a file too short to contain a header length', () => {
  assert.throws(() => SafetensorsFile.parse(Buffer.alloc(4)), /too short/);
});

test('exposes __metadata__ separately from tensor entries', () => {
  const header = {
    __metadata__: { format: 'pt' },
    w: { dtype: 'F32', shape: [1], data_offsets: [0, 4] },
  };
  const headerJson = Buffer.from(JSON.stringify(header), 'utf8');
  const headerLen = Buffer.alloc(8);
  headerLen.writeBigUInt64LE(BigInt(headerJson.length));
  const data = Buffer.alloc(4);
  data.writeFloatLE(7, 0);
  const buf = Buffer.concat([headerLen, headerJson, data]);
  const file = SafetensorsFile.parse(buf);
  assert.deepEqual(file.metadata, { format: 'pt' });
  assert.equal(file.tensors.has('__metadata__'), false);
  assert.deepEqual(Array.from(file.getFloat32('w')), [7]);
});
