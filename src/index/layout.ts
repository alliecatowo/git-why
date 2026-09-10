/**
 * On-disk layout under `<GIT_COMMON_DIR>/why/` (spec section 11).
 *
 * Everything here is path construction and validation ONLY. No filesystem
 * mutation beyond `mkdir -p` of the root scaffolding, and no assumption
 * that any particular path exists. Recursive-delete safety checks live
 * here because they must be applied before every caller in this lane
 * (refresh, gc) touches disk.
 */

import fs from 'node:fs';
import path from 'node:path';
import { GitWhyError } from '../types.js';

export const STATE_DIR_NAME = 'why';
export const CURRENT_FILE_NAME = 'CURRENT';
export const LOCKS_DIR_NAME = 'locks';
export const REPOSITORY_LOCK_NAME = 'repository.lock';
export const GENERATIONS_DIR_NAME = 'generations';
export const STAGING_DIR_NAME = 'staging';
export const MANIFEST_FILE_NAME = 'manifest.json';
export const COLLECTION_DIR_NAME = 'collection';
export const COMMITS_FILE_NAME = 'commits.jsonl';
export const PENDING_FILE_NAME = 'pending.json';
/** Materialised validity intervals and structural links for temporal search. */
export const LINEAGE_FILE_NAME = 'lineage.json';

/** Generation and staging ids are filesystem path segments. Keep them narrow. */
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function isValidGenerationId(id: string): boolean {
  return ID_PATTERN.test(id) && id !== '.' && id !== '..';
}

export function assertValidGenerationId(id: string): void {
  if (!isValidGenerationId(id)) {
    throw new GitWhyError('INTERNAL', `invalid generation id: ${JSON.stringify(id)}`);
  }
}

/** Derives `<commonDir>/why` from an already-resolved, absolute common directory. */
export function stateDirFor(commonDir: string): string {
  if (!path.isAbsolute(commonDir)) {
    throw new GitWhyError(
      'INTERNAL',
      `commonDir must be absolute, got ${JSON.stringify(commonDir)}`,
    );
  }
  return path.join(commonDir, STATE_DIR_NAME);
}

export interface IndexLayout {
  readonly commonDir: string;
  readonly stateDir: string;
  readonly currentFile: string;
  readonly locksDir: string;
  readonly repositoryLockFile: string;
  readonly generationsDir: string;
  readonly stagingRootDir: string;
}

export function layoutFor(commonDir: string): IndexLayout {
  const stateDir = stateDirFor(commonDir);
  return {
    commonDir,
    stateDir,
    currentFile: path.join(stateDir, CURRENT_FILE_NAME),
    locksDir: path.join(stateDir, LOCKS_DIR_NAME),
    repositoryLockFile: path.join(stateDir, LOCKS_DIR_NAME, REPOSITORY_LOCK_NAME),
    generationsDir: path.join(stateDir, GENERATIONS_DIR_NAME),
    stagingRootDir: path.join(stateDir, STAGING_DIR_NAME),
  };
}

export interface GenerationPaths {
  readonly id: string;
  readonly dir: string;
  readonly manifestFile: string;
  readonly collectionDir: string;
  readonly commitsFile: string;
  readonly pendingFile: string;
  readonly lineageFile: string;
}

function generationPathsIn(root: string, id: string): GenerationPaths {
  assertValidGenerationId(id);
  const dir = path.join(root, id);
  return {
    id,
    dir,
    manifestFile: path.join(dir, MANIFEST_FILE_NAME),
    collectionDir: path.join(dir, COLLECTION_DIR_NAME),
    commitsFile: path.join(dir, COMMITS_FILE_NAME),
    pendingFile: path.join(dir, PENDING_FILE_NAME),
    lineageFile: path.join(dir, LINEAGE_FILE_NAME),
  };
}

export function generationPaths(layout: IndexLayout, id: string): GenerationPaths {
  return generationPathsIn(layout.generationsDir, id);
}

export function stagingPaths(layout: IndexLayout, id: string): GenerationPaths {
  return generationPathsIn(layout.stagingRootDir, id);
}

export function ensureScaffolding(layout: IndexLayout): void {
  fs.mkdirSync(layout.generationsDir, { recursive: true });
  fs.mkdirSync(layout.stagingRootDir, { recursive: true });
  fs.mkdirSync(layout.locksDir, { recursive: true });
}

export function readCurrentGenerationId(layout: IndexLayout): string | null {
  try {
    const raw = fs.readFileSync(layout.currentFile, 'utf8').trim();
    return raw.length > 0 ? raw : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new GitWhyError('STORAGE_FAILED', `failed to read CURRENT: ${(err as Error).message}`, {
      cause: err,
    });
  }
}

/** Atomic publish: temp file + fsync + rename, same filesystem as `layout.currentFile`. */
export function publishCurrentGenerationId(layout: IndexLayout, generationId: string): void {
  assertValidGenerationId(generationId);
  fs.mkdirSync(layout.stateDir, { recursive: true });
  const tmp = path.join(layout.stateDir, `.${CURRENT_FILE_NAME}.tmp-${process.pid}-${Date.now()}`);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, generationId);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, layout.currentFile);
  fsyncDirectoryBestEffort(layout.stateDir);
}

export function fsyncDirectoryBestEffort(dir: string): void {
  try {
    const fd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Directory fsync is a best-effort durability nicety on some
    // filesystems/platforms; a failure here must never break the caller.
  }
}

/**
 * Resolve `candidate` and confirm it is safely inside `layout`'s owned
 * generations/staging tree before ANY recursive delete. This is the single
 * chokepoint spec sections 8 and 12 require: reject symlinked or
 * unexpected paths, and never allow deleting the Git common directory (or
 * anything that is not strictly beneath our own generations/staging root).
 */
export function assertSafeToRecursivelyDelete(layout: IndexLayout, candidate: string): void {
  if (!path.isAbsolute(candidate)) {
    throw new GitWhyError('INTERNAL', `refusing to delete a non-absolute path: ${candidate}`);
  }
  const owningRoots = [layout.generationsDir, layout.stagingRootDir];
  const isUnderAnOwnedRoot = owningRoots.some((root) => {
    const rel = path.relative(root, candidate);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
  if (!isUnderAnOwnedRoot) {
    throw new GitWhyError(
      'INTERNAL',
      `refusing to recursively delete a path outside generations/staging: ${candidate}`,
    );
  }
  // The candidate itself (a generation/staging id directory) must not be a
  // symlink — a symlinked "generation" could point anywhere, including at
  // the Git common directory itself.
  let st: fs.Stats;
  try {
    st = fs.lstatSync(candidate);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // nothing to delete
    throw new GitWhyError(
      'STORAGE_FAILED',
      `failed to stat ${candidate}: ${(err as Error).message}`,
      { cause: err },
    );
  }
  if (st.isSymbolicLink()) {
    throw new GitWhyError(
      'INTERNAL',
      `refusing to recursively delete a symlinked path: ${candidate}`,
    );
  }
  // Belt and suspenders: the fully resolved real path must still be under
  // the owned root's real path, and must never equal or contain the Git
  // common directory.
  const realCandidate = fs.realpathSync(candidate);
  const realCommonDir = fs.realpathSync(layout.commonDir);
  if (realCandidate === realCommonDir || realCommonDir.startsWith(realCandidate + path.sep)) {
    throw new GitWhyError(
      'INTERNAL',
      `refusing to recursively delete a path that contains the Git common directory: ${candidate}`,
    );
  }
  const realOwningRoots = owningRoots.map((r) => {
    try {
      return fs.realpathSync(r);
    } catch {
      return r;
    }
  });
  const stillUnderOwnedRoot = realOwningRoots.some((root) => {
    const rel = path.relative(root, realCandidate);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
  if (!stillUnderOwnedRoot) {
    throw new GitWhyError(
      'INTERNAL',
      `refusing to recursively delete a path whose real location escaped generations/staging: ${candidate}`,
    );
  }
}

export function recursivelyRemove(layout: IndexLayout, candidate: string): void {
  assertSafeToRecursivelyDelete(layout, candidate);
  fs.rmSync(candidate, { recursive: true, force: true });
}
