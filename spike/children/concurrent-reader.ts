// Child process: repeatedly query a collection for durationMs, report outcome.
// argv: [colPath, durationMs, readOnlyFlag, enableMMAPFlag]
import { ZVecOpen, isZVecError } from '@zvec/zvec';

const [, , colPath, durationArg, readOnlyArg, mmapArg] = process.argv;
const durationMs = Number(durationArg ?? 1000);
const readOnly = readOnlyArg === 'true';
const enableMMAP = mmapArg === undefined ? undefined : mmapArg === 'true';

const start = Date.now();
let opens = 0;
let queries = 0;
let errors: string[] = [];
try {
  const col = ZVecOpen(colPath!, { readOnly, ...(enableMMAP === undefined ? {} : { enableMMAP }) });
  opens++;
  while (Date.now() - start < durationMs) {
    try {
      col.querySync({ filter: 'ts >= 0', topk: 5, outputFields: ['ts'] });
      queries++;
    } catch (err) {
      errors.push(isZVecError(err) ? err.code : String(err));
    }
  }
  col.closeSync();
} catch (err) {
  errors.push(`open-failed:${isZVecError(err) ? err.code : String(err)}`);
}
process.stdout.write(JSON.stringify({ role: 'reader', opens, queries, errors: errors.slice(0, 10), errorCount: errors.length }) + '\n');
