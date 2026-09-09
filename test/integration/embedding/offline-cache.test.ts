// Once cached, operation must be fully offline (spec section 10). This
// downloads the real model once (network required), then reloads it with
// a `fetchImpl` that throws on any call — simulating network being
// unreachable — and confirms the second load succeeds purely from disk.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureCached } from '../../../src/embedding/cache.js';
import { POTION_CODE_16M_V2 } from '../../../src/embedding/candidates.js';
import { GitWhyError } from '../../../src/types.js';

function blockedFetch(): typeof fetch {
  return (() => {
    throw new Error('network should not be reached once cached');
  }) as unknown as typeof fetch;
}

test('a warm cache reloads with zero network calls', async (t) => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-why-embedding-offline-'));

  let warm;
  try {
    warm = await ensureCached(POTION_CODE_16M_V2, { cacheDir });
  } catch (err) {
    t.skip(`no network access to populate the cache: ${(err as Error).message}`);
    return;
  }
  assert.ok(fs.existsSync(warm.weightsPath));

  // Reload with a fetch implementation that throws if invoked at all.
  const reloaded = await ensureCached(POTION_CODE_16M_V2, { cacheDir, fetchImpl: blockedFetch() });
  assert.deepEqual(reloaded, warm);

  // offline: true must also succeed once warm.
  const offlineReloaded = await ensureCached(POTION_CODE_16M_V2, {
    cacheDir,
    offline: true,
    fetchImpl: blockedFetch(),
  });
  assert.deepEqual(offlineReloaded, warm);
});

test('offline: true against an empty cache fails fast with OFFLINE_REQUIRED_RESOURCE, no network attempted', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-why-embedding-offline-empty-'));
  await assert.rejects(
    () => ensureCached(POTION_CODE_16M_V2, { cacheDir, offline: true, fetchImpl: blockedFetch() }),
    (err: unknown) => err instanceof GitWhyError && err.code === 'OFFLINE_REQUIRED_RESOURCE',
  );
});

test('a partially-downloaded directory (missing manifest) is treated as uncached and re-fetched, not corrupted', async (t) => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-why-embedding-partial-'));
  const dir = path.join(cacheDir, 'minishlab__potion-code-16M-v2', POTION_CODE_16M_V2.revision);
  fs.mkdirSync(dir, { recursive: true });
  // Simulate a crash mid-download: one real file present, no manifest.
  fs.writeFileSync(path.join(dir, 'config.json'), 'garbage, not the real config');

  let result;
  try {
    result = await ensureCached(POTION_CODE_16M_V2, { cacheDir });
  } catch (err) {
    t.skip(`no network access to complete the re-fetch: ${(err as Error).message}`);
    return;
  }
  const configBytes = fs.readFileSync(result.configPath, 'utf8');
  assert.notEqual(configBytes, 'garbage, not the real config');
  assert.ok(fs.existsSync(path.join(dir, 'manifest.json')));
});
