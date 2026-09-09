// Child process for concurrent-download.test.ts: one process calling
// ensureCached() against a shared cache directory. Prints a single JSON
// line to stdout on success or failure so the parent can assert on it.

import { ensureCached } from '../../../../src/embedding/cache.js';
import { POTION_CODE_16M_V2 } from '../../../../src/embedding/candidates.js';

const cacheDir = process.argv[2];
if (!cacheDir) {
  console.error('usage: download-worker.ts <cacheDir>');
  process.exit(2);
}

ensureCached(POTION_CODE_16M_V2, { cacheDir })
  .then((paths) => {
    console.log(JSON.stringify({ ok: true, pid: process.pid, paths }));
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.log(JSON.stringify({ ok: false, pid: process.pid, error: String(err) }));
    process.exit(1);
  });
