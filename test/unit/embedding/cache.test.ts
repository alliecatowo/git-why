// Unit coverage for src/embedding/cache.ts that needs no network: cache
// root resolution precedence, and the offline-mode short-circuit. Real
// downloads and cross-process lock coordination are exercised in
// test/integration/embedding/ (network, real child processes).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureCached,
  resolveCacheRoot,
  type PinnedArtifact,
} from '../../../src/embedding/cache.js';
import { GitWhyError } from '../../../src/types.js';

test('resolveCacheRoot honours GIT_WHY_MODEL_CACHE above everything else', () => {
  const root = resolveCacheRoot(
    { GIT_WHY_MODEL_CACHE: '/custom/cache', XDG_CACHE_HOME: '/xdg' } as NodeJS.ProcessEnv,
    'linux',
  );
  assert.equal(root, '/custom/cache');
});

test('resolveCacheRoot honours XDG_CACHE_HOME when no override is set', () => {
  const root = resolveCacheRoot({ XDG_CACHE_HOME: '/xdg' } as NodeJS.ProcessEnv, 'linux');
  assert.equal(root, path.join('/xdg', 'git-why', 'models'));
});

test('resolveCacheRoot defaults to the macOS cache directory', () => {
  const root = resolveCacheRoot({} as NodeJS.ProcessEnv, 'darwin');
  assert.equal(root, path.join(os.homedir(), 'Library', 'Caches', 'git-why', 'models'));
});

test('resolveCacheRoot defaults to the XDG-style Linux cache directory', () => {
  const root = resolveCacheRoot({} as NodeJS.ProcessEnv, 'linux');
  assert.equal(root, path.join(os.homedir(), '.cache', 'git-why', 'models'));
});

const FAKE_ARTIFACT: PinnedArtifact = {
  modelId: 'test/fake-model',
  revision: 'abc123',
  config: { filename: 'config.json', sha256: 'x'.repeat(64) },
  tokenizer: { filename: 'tokenizer.json', sha256: 'y'.repeat(64) },
  weights: { filename: 'model.safetensors', sha256: 'z'.repeat(64) },
};

function tempCacheDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'git-why-cache-test-'));
}

test('offline mode with an empty cache throws OFFLINE_REQUIRED_RESOURCE and never calls fetch', async () => {
  const cacheDir = tempCacheDir();
  let fetchCalled = false;
  const fetchImpl = (() => {
    fetchCalled = true;
    throw new Error('should not be called');
  }) as unknown as typeof fetch;

  await assert.rejects(
    () => ensureCached(FAKE_ARTIFACT, { offline: true, cacheDir, fetchImpl }),
    (err: unknown) => err instanceof GitWhyError && err.code === 'OFFLINE_REQUIRED_RESOURCE',
  );
  assert.equal(fetchCalled, false);
});

test('a fully-populated cache with a matching manifest is used without calling fetch, online or offline', async () => {
  const cacheDir = tempCacheDir();
  const dir = path.join(cacheDir, 'test__fake-model', 'abc123');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), 'irrelevant bytes for this test');
  fs.writeFileSync(path.join(dir, 'tokenizer.json'), 'irrelevant bytes for this test');
  fs.writeFileSync(path.join(dir, 'model.safetensors'), 'irrelevant bytes for this test');
  // Manifest hashes must match the pinned hashes for isFullyCached to
  // accept it — use the pinned (fake) hashes directly, since this test
  // only checks that a satisfied manifest short-circuits network use, not
  // that hashing itself is correct (safetensors.test.ts and the real
  // download path cover that).
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      modelId: FAKE_ARTIFACT.modelId,
      revision: FAKE_ARTIFACT.revision,
      files: {
        [FAKE_ARTIFACT.config.filename]: FAKE_ARTIFACT.config.sha256,
        [FAKE_ARTIFACT.tokenizer.filename]: FAKE_ARTIFACT.tokenizer.sha256,
        [FAKE_ARTIFACT.weights.filename]: FAKE_ARTIFACT.weights.sha256,
      },
      cachedAt: new Date().toISOString(),
    }),
  );

  let fetchCalled = false;
  const fetchImpl = (() => {
    fetchCalled = true;
    throw new Error('should not be called');
  }) as unknown as typeof fetch;

  const paths = await ensureCached(FAKE_ARTIFACT, { cacheDir, fetchImpl });
  assert.equal(fetchCalled, false);
  assert.equal(paths.configPath, path.join(dir, 'config.json'));
  assert.equal(paths.tokenizerPath, path.join(dir, 'tokenizer.json'));
  assert.equal(paths.weightsPath, path.join(dir, 'model.safetensors'));

  // Also true under offline: a satisfied cache is always usable offline.
  const offlinePaths = await ensureCached(FAKE_ARTIFACT, { cacheDir, offline: true, fetchImpl });
  assert.deepEqual(offlinePaths, paths);
});

test('a checksum mismatch is reported as MODEL_DOWNLOAD_FAILED, not silently accepted', async () => {
  const cacheDir = tempCacheDir();
  let call = 0;
  const fetchImpl = (async () => {
    call++;
    const body = new Response(Buffer.from('wrong bytes that will not hash to the pinned value'));
    return new Response(body.body, { status: 200, headers: { 'content-length': '10' } });
  }) as unknown as typeof fetch;

  await assert.rejects(
    () => ensureCached(FAKE_ARTIFACT, { cacheDir, fetchImpl, lockTimeoutMs: 2000 }),
    (err: unknown) => err instanceof GitWhyError && err.code === 'MODEL_DOWNLOAD_FAILED',
  );
  assert.ok(call >= 1);
});

test('a 404 is reported as MODEL_UNAVAILABLE and is not retried three times', async () => {
  const cacheDir = tempCacheDir();
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response(null, { status: 404, statusText: 'Not Found' });
  }) as unknown as typeof fetch;

  await assert.rejects(
    () => ensureCached(FAKE_ARTIFACT, { cacheDir, fetchImpl, lockTimeoutMs: 2000 }),
    (err: unknown) => err instanceof GitWhyError && err.code === 'MODEL_UNAVAILABLE',
  );
  assert.equal(calls, 1); // permanent failure — must not burn the retry budget
});
