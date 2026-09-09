// Child process: open an existing collection read-only and report doc count.
import { ZVecOpen } from '@zvec/zvec';

const [, , colPath] = process.argv;
const col = ZVecOpen(colPath!, { readOnly: true });
const docs = col.fetchSync({ ids: Array.from({ length: 20 }, (_, i) => `${'0'.repeat(63)}${i}`.slice(-64)) });
process.stdout.write(JSON.stringify({ docCount: col.stats.docCount, fetched: Object.keys(docs).length }) + '\n');
col.closeSync();
