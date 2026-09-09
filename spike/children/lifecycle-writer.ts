// Child process: create/open a collection, insert a batch, optionally close.
// argv: [colPath, mode]  mode = 'close' | 'no-close' | 'checkpoint-then-noop'
import { ZVecCreateAndOpen, ZVecOpen, ZVecCollectionSchema, ZVecDataType, ZVecIndexType, ZVecMetricType, isZVecError } from '@zvec/zvec';
import fs from 'node:fs';

const [, , colPath, mode, countArg] = process.argv;
const count = countArg ? Number(countArg) : 5;

function schema() {
  return new ZVecCollectionSchema({
    name: 'lifecycle',
    fields: [{ name: 'seq', dataType: ZVecDataType.INT64, indexParams: { indexType: ZVecIndexType.INVERT } }],
    vectors: [{ name: 'vec', dataType: ZVecDataType.VECTOR_FP32, dimension: 8, indexParams: { indexType: ZVecIndexType.FLAT, metricType: ZVecMetricType.COSINE } }],
  });
}

let col;
if (fs.existsSync(colPath)) {
  col = ZVecOpen(colPath);
} else {
  col = ZVecCreateAndOpen(colPath!, schema());
}

const docs = Array.from({ length: count }, (_, i) => ({
  id: `${'0'.repeat(63)}${i}`.slice(-64),
  fields: { seq: i },
  vectors: { vec: new Float32Array(8).fill(i / 10) },
}));
const statuses = col.upsertSync(docs);
process.stdout.write(JSON.stringify({ phase: 'inserted', statuses }) + '\n');

if (mode === 'close') {
  col.closeSync();
  process.stdout.write(JSON.stringify({ phase: 'closed' }) + '\n');
} else if (mode === 'no-close') {
  // Simulate a hard crash before checkpoint: parent SIGKILLs us right after
  // this line prints, so no closeSync ever runs.
  process.stdout.write(JSON.stringify({ phase: 'ready-to-be-killed' }) + '\n');
  // Park so the parent has time to deliver SIGKILL deterministically.
  setInterval(() => {}, 1000);
} else {
  process.stdout.write(JSON.stringify({ phase: 'unknown-mode', mode }) + '\n');
}
