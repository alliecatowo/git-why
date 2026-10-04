// Unit coverage for src/embedding/cache.ts that needs no network: cache
// root resolution precedence, and the offline-mode short-circuit. Real
// downloads and cross-process lock coordination are exercised in
// test/integration/embedding/ (network, real child processes).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  ensureCached,
  isOffline,
  resolveBaseUrl,
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

const FILE_BYTES = 'irrelevant bytes for this test';
const FILE_SHA = createHash('sha256').update(FILE_BYTES).digest('hex');

const FAKE_ARTIFACT: PinnedArtifact = {
  modelId: 'test/fake-model',
  revision: 'abc123',
  config: { filename: 'config.json', sha256: FILE_SHA },
  tokenizer: { filename: 'tokenizer.json', sha256: FILE_SHA },
  weights: { filename: 'model.safetensors', sha256: FILE_SHA },
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
  fs.writeFileSync(path.join(dir, 'config.json'), FILE_BYTES);
  fs.writeFileSync(path.join(dir, 'tokenizer.json'), FILE_BYTES);
  fs.writeFileSync(path.join(dir, 'model.safetensors'), FILE_BYTES);
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

test('a tampered cached file is not trusted: it is re-fetched instead of loaded', async () => {
  const cacheDir = tempCacheDir();
  const dir = path.join(cacheDir, 'test__fake-model', 'abc123');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['config.json', 'tokenizer.json', 'model.safetensors']) {
    fs.writeFileSync(path.join(dir, f), 'tampered');
  }
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      modelId: FAKE_ARTIFACT.modelId,
      revision: FAKE_ARTIFACT.revision,
      files: {
        [FAKE_ARTIFACT.config.filename]: FILE_SHA,
        [FAKE_ARTIFACT.tokenizer.filename]: FILE_SHA,
        [FAKE_ARTIFACT.weights.filename]: FILE_SHA,
      },
      cachedAt: new Date().toISOString(),
    }),
  );
  await assert.rejects(
    () => ensureCached(FAKE_ARTIFACT, { cacheDir, offline: true }),
    (err: unknown) => err instanceof GitWhyError && err.code === 'OFFLINE_REQUIRED_RESOURCE',
  );
});

test('a stalled download is aborted by the idle timeout instead of holding the lock forever', async () => {
  const cacheDir = tempCacheDir();
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    // Headers arrive, then the body never produces another byte.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason));
      },
    });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  const started = Date.now();
  await assert.rejects(
    () => ensureCached(FAKE_ARTIFACT, { cacheDir, fetchImpl, stallTimeoutMs: 40 }),
    (err: unknown) => err instanceof GitWhyError && err.code === 'MODEL_DOWNLOAD_FAILED',
  );
  assert.ok(Date.now() - started < 10_000);
  // The lock is released even though every attempt failed.
  const dir = path.join(cacheDir, 'test__fake-model', 'abc123');
  assert.equal(fs.existsSync(path.join(dir, '.download.lock')), false);
});

test('GIT_WHY_MODEL_BASE_URL redirects downloads to a mirror but hashes are still enforced', async () => {
  const env = { GIT_WHY_MODEL_BASE_URL: 'https://mirror.example/hf/' } as NodeJS.ProcessEnv;
  assert.equal(resolveBaseUrl(env), 'https://mirror.example/hf');
  assert.equal(resolveBaseUrl({} as NodeJS.ProcessEnv), 'https://huggingface.co');
  assert.throws(() => resolveBaseUrl({ GIT_WHY_MODEL_BASE_URL: 'not a url' } as NodeJS.ProcessEnv));
  assert.throws(() =>
    resolveBaseUrl({ GIT_WHY_MODEL_BASE_URL: 'file:///etc' } as NodeJS.ProcessEnv),
  );

  const cacheDir = tempCacheDir();
  const urls: string[] = [];
  const previous = process.env.GIT_WHY_MODEL_BASE_URL;
  process.env.GIT_WHY_MODEL_BASE_URL = 'https://mirror.example/hf/';
  try {
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return new Response('tampered bytes', { status: 200 });
    }) as unknown as typeof fetch;
    await assert.rejects(
      () => ensureCached(FAKE_ARTIFACT, { cacheDir, fetchImpl }),
      (err: unknown) => err instanceof GitWhyError && err.code === 'MODEL_DOWNLOAD_FAILED',
    );
  } finally {
    if (previous === undefined) delete process.env.GIT_WHY_MODEL_BASE_URL;
    else process.env.GIT_WHY_MODEL_BASE_URL = previous;
  }
  assert.ok(urls.length > 0);
  assert.ok(
    urls.every((u) => u.startsWith('https://mirror.example/hf/test/fake-model/resolve/abc123/')),
  );
});

test('GIT_WHY_OFFLINE forbids downloads the same way --offline does', async () => {
  assert.equal(isOffline({}, { GIT_WHY_OFFLINE: '1' } as NodeJS.ProcessEnv), true);
  assert.equal(isOffline({}, { GIT_WHY_OFFLINE: 'true' } as NodeJS.ProcessEnv), true);
  assert.equal(isOffline({}, { GIT_WHY_OFFLINE: '0' } as NodeJS.ProcessEnv), false);
  assert.equal(isOffline({ offline: true }, {} as NodeJS.ProcessEnv), true);

  const previous = process.env.GIT_WHY_OFFLINE;
  process.env.GIT_WHY_OFFLINE = '1';
  try {
    const fetchImpl = (() => {
      throw new Error('must not download');
    }) as unknown as typeof fetch;
    await assert.rejects(
      () => ensureCached(FAKE_ARTIFACT, { cacheDir: tempCacheDir(), fetchImpl }),
      (err: unknown) => err instanceof GitWhyError && err.code === 'OFFLINE_REQUIRED_RESOURCE',
    );
  } finally {
    if (previous === undefined) delete process.env.GIT_WHY_OFFLINE;
    else process.env.GIT_WHY_OFFLINE = previous;
  }
});

test('a lock whose owner is alive and heartbeating is not reclaimed; a dead owner is', async () => {
  const cacheDir = tempCacheDir();
  const dir = path.join(cacheDir, 'test__fake-model', 'abc123');
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, '.download.lock');
  // Dead owner (pid far above any real one) with an old acquiredAt: reclaimed, download proceeds.
  fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, acquiredAt: 1 }));
  let called = 0;
  const fetchImpl = (async () => {
    called++;
    return new Response('x', { status: 404 });
  }) as unknown as typeof fetch;
  await assert.rejects(() => ensureCached(FAKE_ARTIFACT, { cacheDir, fetchImpl }));
  assert.equal(called, 1);

  // Live owner (this process) acquired long ago but mtime is fresh: kept, so we time out waiting.
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, acquiredAt: 1 }));
  await assert.rejects(
    () => ensureCached(FAKE_ARTIFACT, { cacheDir, fetchImpl, lockTimeoutMs: 150 }),
    /timed out waiting/,
  );
  assert.equal(called, 1);
});
