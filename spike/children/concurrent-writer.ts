// Child process: repeatedly upsert into a collection for durationMs.
// argv: [colPath, durationMs, tag]
import { ZVecOpen, isZVecError } from '@zvec/zvec';

const [, , colPath, durationArg, tag] = process.argv;
const durationMs = Number(durationArg ?? 1000);

const start = Date.now();
let writes = 0;
let errors: string[] = [];
try {
  const col = ZVecOpen(colPath!, { readOnly: false });
  let i = 0;
  while (Date.now() - start < durationMs) {
    try {
      const id = `${tag}${'0'.repeat(60 - String(tag).length)}${String(i % 50).padStart(4, '0')}`.slice(-64);
      col.upsertSync({
        id,
        fields: { kind: 'commit', ts: i, author: `writer-${tag}`, paths: ['x'], text: 'concurrent write' },
        vectors: { vec: new Float32Array(8).fill((i % 50) / 50) },
      });
      writes++;
    } catch (err) {
      errors.push(isZVecError(err) ? err.code : String(err));
    }
    i++;
  }
  col.closeSync();
} catch (err) {
  errors.push(`open-failed:${isZVecError(err) ? err.code : String(err)}`);
}
process.stdout.write(JSON.stringify({ role: 'writer', tag, writes, errors: errors.slice(0, 10), errorCount: errors.length }) + '\n');
