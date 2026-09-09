// Two real OS processes racing to populate the same empty model cache
// directory for the first time. The lock in src/embedding/cache.ts must
// serialize the actual download so the cache ends up with one consistent,
// checksum-verified copy — not two processes writing the same files at
// once, and not a corrupted partial file left behind by a loser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { POTION_CODE_16M_V2 } from '../../../src/embedding/candidates.js';

const execFileAsync = promisify(execFile);
const workerPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'helpers',
  'download-worker.ts',
);

function sha256OfFile(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

test('two concurrent first-time downloads converge on one verified cache, with no corruption', async (t) => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-why-embedding-concurrent-'));

  const spawnOne = () =>
    execFileAsync(process.execPath, [workerPath, cacheDir]).catch(
      (err) => err as { stdout: string; stderr: string },
    );

  const [r1, r2] = await Promise.all([spawnOne(), spawnOne()]);
  const out1 = (r1 as { stdout: string }).stdout.trim();
  const out2 = (r2 as { stdout: string }).stdout.trim();

  let parsed1: { ok: boolean; error?: string };
  let parsed2: { ok: boolean; error?: string };
  try {
    parsed1 = JSON.parse(out1);
    parsed2 = JSON.parse(out2);
  } catch {
    t.skip(`worker output was not JSON — likely no network access:\n${out1}\n${out2}`);
    return;
  }

  if (!parsed1.ok && /network|fetch|ENOTFOUND|MODEL_DOWNLOAD_FAILED/i.test(parsed1.error ?? '')) {
    t.skip(`no network access to run the concurrent download: ${parsed1.error}`);
    return;
  }

  assert.equal(parsed1.ok, true, `worker 1 failed: ${parsed1.error}`);
  assert.equal(parsed2.ok, true, `worker 2 failed: ${parsed2.error}`);

  // Exactly one final copy of each file, hashing to the pinned checksum.
  const dir = path.join(cacheDir, 'minishlab__potion-code-16M-v2', POTION_CODE_16M_V2.revision);
  assert.equal(sha256OfFile(path.join(dir, 'config.json')), POTION_CODE_16M_V2.config.sha256);
  assert.equal(sha256OfFile(path.join(dir, 'tokenizer.json')), POTION_CODE_16M_V2.tokenizer.sha256);
  assert.equal(
    sha256OfFile(path.join(dir, 'model.safetensors')),
    POTION_CODE_16M_V2.weights.sha256,
  );

  // No leftover lock file or temp download artifacts.
  const entries = fs.readdirSync(dir);
  const leftover = entries.filter((e) => e.startsWith('.'));
  assert.deepEqual(
    leftover,
    [],
    `unexpected leftover files after both downloads finished: ${leftover.join(', ')}`,
  );
});
