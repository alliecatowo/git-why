/**
 * User-level artifact cache for embedding model files, and the lazy
 * download that populates it. Lives outside any repository so N clones on
 * one machine share one download. Layout:
 *
 *   <cacheRoot>/<modelId with '/' -> '__'>/<revision>/
 *     config.json
 *     tokenizer.json
 *     model.safetensors
 *     manifest.json        # written last, atomically; its presence with
 *                           # matching hashes is what "cached" means
 *     .download.lock        # transient, held only while downloading
 *
 * `<cacheRoot>` resolution order: `GIT_WHY_MODEL_CACHE` env override, else
 * `XDG_CACHE_HOME`, else the platform default cache directory. Artifact
 * identity (model id, revision, expected sha256 of each file) is supplied
 * by the caller — see `src/embedding/candidates.ts` for the pinned values
 * this ships with. This module never resolves "main" to a commit itself;
 * it only ever fetches the exact pinned revision, and only ever accepts
 * bytes that hash to the pinned checksum. That is what "trusted artifact
 * locations and checksums" (spec section 10) means in practice: a newly
 * published revision of the same model repo cannot silently substitute
 * itself in without a code change that updates the pin.
 */

import { createHash } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GitWhyError } from '../types.js';

export interface PinnedFile {
  readonly filename: string;
  readonly sha256: string;
}

/** Everything needed to fetch, verify and cache one model's artifacts, with no runtime resolution. */
export interface PinnedArtifact {
  readonly modelId: string;
  readonly revision: string;
  readonly config: PinnedFile;
  readonly tokenizer: PinnedFile;
  readonly weights: PinnedFile;
}

export interface CachedPaths {
  readonly configPath: string;
  readonly tokenizerPath: string;
  readonly weightsPath: string;
}

export interface DownloadProgress {
  readonly modelId: string;
  readonly file: string;
  readonly bytesDownloaded: number;
  /** Null when the server did not report Content-Length. */
  readonly totalBytes: number | null;
}

export type ProgressCallback = (progress: DownloadProgress) => void;

export interface CacheOptions {
  /** Refuse to download; only ever read what is already cached. */
  readonly offline?: boolean;
  /** Override the computed cache root. Primarily for tests. */
  readonly cacheDir?: string;
  readonly onProgress?: ProgressCallback;
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  readonly lockTimeoutMs?: number;
}

const DEFAULT_LOCK_TIMEOUT_MS = 5 * 60 * 1000;
const LOCK_STALE_MS = 10 * 60 * 1000;
const HF_BASE_URL = 'https://huggingface.co';
const MAX_DOWNLOAD_ATTEMPTS = 3;

export function resolveCacheRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (env.GIT_WHY_MODEL_CACHE) return env.GIT_WHY_MODEL_CACHE;
  if (env.XDG_CACHE_HOME) return path.join(env.XDG_CACHE_HOME, 'git-why', 'models');
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'git-why', 'models');
  return path.join(os.homedir(), '.cache', 'git-why', 'models');
}

function modelSlug(modelId: string): string {
  return modelId.replace(/\//g, '__');
}

function targetDir(cacheRoot: string, artifact: PinnedArtifact): string {
  return path.join(cacheRoot, modelSlug(artifact.modelId), artifact.revision);
}

interface Manifest {
  readonly modelId: string;
  readonly revision: string;
  readonly files: Readonly<Record<string, string>>;
  readonly cachedAt: string;
}

function manifestPath(dir: string): string {
  return path.join(dir, 'manifest.json');
}

function readManifest(dir: string): Manifest | null {
  try {
    const raw = fs.readFileSync(manifestPath(dir), 'utf8');
    return JSON.parse(raw) as Manifest;
  } catch {
    return null;
  }
}

/** True when the manifest exists and every file it lists is present with the expected hash. */
function isFullyCached(dir: string, artifact: PinnedArtifact): boolean {
  const manifest = readManifest(dir);
  if (!manifest) return false;
  const expected: Record<string, PinnedFile> = {
    [artifact.config.filename]: artifact.config,
    [artifact.tokenizer.filename]: artifact.tokenizer,
    [artifact.weights.filename]: artifact.weights,
  };
  for (const [filename, pinned] of Object.entries(expected)) {
    if (manifest.files[filename] !== pinned.sha256) return false;
    if (!fs.existsSync(path.join(dir, filename))) return false;
  }
  return true;
}

function pathsFor(dir: string, artifact: PinnedArtifact): CachedPaths {
  return {
    configPath: path.join(dir, artifact.config.filename),
    tokenizerPath: path.join(dir, artifact.tokenizer.filename),
    weightsPath: path.join(dir, artifact.weights.filename),
  };
}

/* -------------------------------------------------------------------- *
 * Cross-process download coordination: a single exclusive lock file per
 * <modelId>/<revision> directory, created with O_EXCL. Staleness is
 * reclaimed either by process death (best-effort liveness probe) or by
 * age, so a crashed downloader cannot wedge the cache forever.
 * -------------------------------------------------------------------- */

interface LockToken {
  readonly pid: number;
  readonly acquiredAt: number;
}

function lockFilePath(dir: string): string {
  return path.join(dir, '.download.lock');
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no such process. EPERM: exists, owned by someone else (alive).
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLockToken(lockPath: string): LockToken | null {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LockToken;
  } catch {
    return null;
  }
}

function reclaimIfStale(lockPath: string): void {
  const token = readLockToken(lockPath);
  if (!token) return; // unreadable/partial write from a racer; leave to retry
  const stale = !isProcessAlive(token.pid) || Date.now() - token.acquiredAt > LOCK_STALE_MS;
  if (stale) {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // already gone
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitteredBackoff(attempt: number): number {
  const base = Math.min(500, 25 * 2 ** Math.min(attempt, 5));
  return base + Math.random() * base * 0.5;
}

async function withDownloadLock<T>(dir: string, timeoutMs: number, body: () => Promise<T>): Promise<T> {
  const lockPath = lockFilePath(dir);
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  for (;;) {
    if (fs.existsSync(lockPath)) reclaimIfStale(lockPath);
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() } satisfies LockToken));
      } finally {
        fs.closeSync(fd);
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (Date.now() > deadline) {
        throw new GitWhyError('MODEL_DOWNLOAD_FAILED', `timed out waiting for a concurrent model download to finish (${dir})`);
      }
      await sleep(jitteredBackoff(attempt++));
    }
  }
  try {
    return await body();
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // already gone
    }
  }
}

/* -------------------------------------------------------------------- *
 * Download + verify + install, one file at a time (no worker pool, no
 * unbounded parallelism — eight concurrent `git why` processes each do at
 * most one network request at a time for at most one model directory).
 * -------------------------------------------------------------------- */

function sha256OfFile(filePath: string): string {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

async function downloadOne(
  artifact: PinnedArtifact,
  file: PinnedFile,
  dir: string,
  fetchImpl: typeof fetch,
  onProgress: ProgressCallback | undefined,
): Promise<void> {
  const url = `${HF_BASE_URL}/${artifact.modelId}/resolve/${artifact.revision}/${file.filename}`;
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_DOWNLOAD_ATTEMPTS; attempt++) {
    const tmpPath = path.join(dir, `.${file.filename}.tmp-${randomBytes(6).toString('hex')}`);
    try {
      const res = await fetchImpl(url, { redirect: 'follow' });
      if (res.status === 404 || res.status === 410) {
        // Permanent: this pinned revision/file does not exist at the
        // trusted location. Retrying won't help — surface immediately
        // rather than burning the retry budget on a 404.
        throw new GitWhyError(
          'MODEL_UNAVAILABLE',
          `${artifact.modelId}@${artifact.revision} file '${file.filename}' was not found (${res.status})`,
        );
      }
      if (!res.ok || !res.body) {
        throw new Error(`download failed: ${res.status} ${res.statusText} for ${url}`);
      }
      const totalHeader = res.headers.get('content-length');
      const totalBytes = totalHeader ? Number(totalHeader) : null;
      let bytesDownloaded = 0;
      const fileHandle = await fsPromises.open(tmpPath, 'wx');
      try {
        const writable = fileHandle.createWriteStream();
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          bytesDownloaded += chunk.length;
          onProgress?.({ modelId: artifact.modelId, file: file.filename, bytesDownloaded, totalBytes });
          if (!writable.write(chunk)) {
            await new Promise<void>((resolve) => writable.once('drain', resolve));
          }
        }
        await new Promise<void>((resolve, reject) => {
          writable.end((err: unknown) => (err ? reject(err) : resolve()));
        });
      } finally {
        await fileHandle.close();
      }

      const actualHash = sha256OfFile(tmpPath);
      if (actualHash !== file.sha256) {
        await fsPromises.unlink(tmpPath).catch(() => {});
        throw new Error(
          `checksum mismatch for ${file.filename}: expected ${file.sha256}, got ${actualHash} (possible tampering, mirror drift, or a stale pin)`,
        );
      }
      await fsPromises.rename(tmpPath, path.join(dir, file.filename));
      return;
    } catch (err) {
      await fsPromises.unlink(tmpPath).catch(() => {});
      if (err instanceof GitWhyError && err.code === 'MODEL_UNAVAILABLE') {
        throw err; // permanent, do not retry
      }
      lastError = err;
      if (attempt < MAX_DOWNLOAD_ATTEMPTS - 1) {
        await sleep(jitteredBackoff(attempt));
      }
    }
  }
  throw new GitWhyError('MODEL_DOWNLOAD_FAILED', `failed to download ${file.filename} for ${artifact.modelId}`, {
    cause: lastError,
  });
}

/**
 * Ensure `artifact`'s three files are present and checksum-verified under
 * the cache root, downloading if necessary. Fully offline once cached.
 */
export async function ensureCached(artifact: PinnedArtifact, options: CacheOptions = {}): Promise<CachedPaths> {
  const cacheRoot = options.cacheDir ?? resolveCacheRoot();
  const dir = targetDir(cacheRoot, artifact);

  if (isFullyCached(dir, artifact)) {
    return pathsFor(dir, artifact);
  }

  if (options.offline) {
    throw new GitWhyError(
      'OFFLINE_REQUIRED_RESOURCE',
      `${artifact.modelId}@${artifact.revision} is not cached locally and --offline forbids downloading it`,
      { hint: `Run once without --offline to populate ${dir}, or set GIT_WHY_MODEL_CACHE to a pre-populated cache.` },
    );
  }

  fs.mkdirSync(dir, { recursive: true });
  const fetchImpl = options.fetchImpl ?? fetch;
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;

  return withDownloadLock(dir, lockTimeoutMs, async () => {
    // Another process may have finished while we waited for the lock.
    if (isFullyCached(dir, artifact)) return pathsFor(dir, artifact);

    for (const file of [artifact.config, artifact.tokenizer, artifact.weights]) {
      if (fs.existsSync(path.join(dir, file.filename)) && sha256OfFile(path.join(dir, file.filename)) === file.sha256) {
        continue; // partial prior run already got this one right
      }
      await downloadOne(artifact, file, dir, fetchImpl, options.onProgress);
    }

    const manifest: Manifest = {
      modelId: artifact.modelId,
      revision: artifact.revision,
      files: {
        [artifact.config.filename]: artifact.config.sha256,
        [artifact.tokenizer.filename]: artifact.tokenizer.sha256,
        [artifact.weights.filename]: artifact.weights.sha256,
      },
      cachedAt: new Date().toISOString(),
    };
    const tmpManifest = path.join(dir, `.manifest.tmp-${randomBytes(6).toString('hex')}`);
    fs.writeFileSync(tmpManifest, JSON.stringify(manifest, null, 2));
    fs.renameSync(tmpManifest, manifestPath(dir));

    return pathsFor(dir, artifact);
  });
}
