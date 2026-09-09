/**
 * Cross-process shared/exclusive advisory lock on the stable repository
 * lock file (spec section 13). Node stdlib only — see docs/decisions.md
 * section 8 for the empirical protocol design and the child-process tests
 * that validated it (`spike/run.ts` probes 8.1-8.4, using the prototype in
 * `spike/lock-proto.ts`).
 *
 * Readers hold shared access from manifest validation through collection
 * close. Writers hold exclusive access through mutation, publication,
 * recovery and cleanup. Locks are released by deleting the owning file;
 * process death is detected (never a timer) via liveness + a recorded
 * process start time, so a live process's lock is never stolen.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { GitWhyError } from '../types.js';

export const DEFAULT_LOCK_TIMEOUT_SECONDS = 30;

export interface LockHandle {
  readonly kind: 'shared' | 'exclusive';
  /** Idempotent. */
  release(): void;
}

interface LockToken {
  readonly pid: number;
  readonly startTime: string;
  readonly acquiredAt: number;
}

function getProcessStartTime(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const line = out.trim();
    return line.length > 0 ? line : null;
  } catch {
    return null;
  }
}

/** Dead pid, OR alive but not the process that wrote the token (pid reuse after a crash/reboot). */
function isStale(pid: number, recordedStartTime: string): boolean {
  const current = getProcessStartTime(pid);
  if (current === null) return true;
  if (recordedStartTime === '') return false; // `ps` was unavailable when the token was written; degrade to trusting existence.
  return current !== recordedStartTime;
}

function selfToken(): LockToken {
  return { pid: process.pid, startTime: getProcessStartTime(process.pid) ?? '', acquiredAt: Date.now() };
}

function writeTokenFile(filePath: string): void {
  const fd = fs.openSync(filePath, 'wx');
  try {
    fs.writeFileSync(fd, JSON.stringify(selfToken()));
  } finally {
    fs.closeSync(fd);
  }
}

function readTokenFile(filePath: string): LockToken | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as LockToken;
  } catch {
    return null;
  }
}

function removeQuiet(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // already gone — release is idempotent
  }
}

function reclaimExclusiveIfStale(lockFile: string): void {
  const token = readTokenFile(lockFile);
  if (token === null) return; // absent or unreadable; caller's create-attempt will sort it out
  if (isStale(token.pid, token.startTime)) removeQuiet(lockFile);
}

function pruneStaleReaders(readersDir: string): number {
  let entries: string[];
  try {
    entries = fs.readdirSync(readersDir);
  } catch {
    return 0;
  }
  let remaining = 0;
  for (const entry of entries) {
    const full = path.join(readersDir, entry);
    const token = readTokenFile(full);
    if (token === null) {
      removeQuiet(full);
      continue;
    }
    if (isStale(token.pid, token.startTime)) removeQuiet(full);
    else remaining++;
  }
  return remaining;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitteredBackoff(attempt: number): number {
  const base = Math.min(200, 10 * 2 ** Math.min(attempt, 5));
  return base + Math.random() * base * 0.5;
}

interface LockPaths {
  readonly lockFile: string;
  readonly readersDir: string;
}

function lockPathsFor(repositoryLockFile: string): LockPaths {
  return { lockFile: repositoryLockFile, readersDir: path.join(path.dirname(repositoryLockFile), 'readers') };
}

function timeoutError(kind: string, lockFile: string): GitWhyError {
  return new GitWhyError('INDEX_BUSY', `timed out acquiring ${kind} lock on ${lockFile}`, {
    hint: 'another git-why process is using the index; retry, or pass a longer --lock-timeout',
  });
}

/** Acquire shared (reader) access. `timeoutSeconds` defaults to `DEFAULT_LOCK_TIMEOUT_SECONDS`. */
export async function acquireShared(repositoryLockFile: string, timeoutSeconds = DEFAULT_LOCK_TIMEOUT_SECONDS): Promise<LockHandle> {
  const { lockFile, readersDir } = lockPathsFor(repositoryLockFile);
  fs.mkdirSync(readersDir, { recursive: true });
  const deadline = Date.now() + timeoutSeconds * 1000;
  let attempt = 0;
  for (;;) {
    if (fs.existsSync(lockFile)) reclaimExclusiveIfStale(lockFile);
    if (!fs.existsSync(lockFile)) {
      const readerFile = path.join(readersDir, `${process.pid}-${crypto.randomBytes(4).toString('hex')}.json`);
      writeTokenFile(readerFile);
      if (!fs.existsSync(lockFile)) {
        let released = false;
        return {
          kind: 'shared',
          release: () => {
            if (released) return;
            released = true;
            removeQuiet(readerFile);
          },
        };
      }
      removeQuiet(readerFile); // a writer raced in; back off and retry
    }
    if (Date.now() > deadline) throw timeoutError('shared', lockFile);
    await sleep(jitteredBackoff(attempt++));
  }
}

/** Acquire exclusive (writer) access. `timeoutSeconds` defaults to `DEFAULT_LOCK_TIMEOUT_SECONDS`. */
export async function acquireExclusive(repositoryLockFile: string, timeoutSeconds = DEFAULT_LOCK_TIMEOUT_SECONDS): Promise<LockHandle> {
  const { lockFile, readersDir } = lockPathsFor(repositoryLockFile);
  fs.mkdirSync(readersDir, { recursive: true });
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const deadline = Date.now() + timeoutSeconds * 1000;
  let attempt = 0;
  for (;;) {
    if (fs.existsSync(lockFile)) reclaimExclusiveIfStale(lockFile);
    const liveReaders = pruneStaleReaders(readersDir);
    if (!fs.existsSync(lockFile) && liveReaders === 0) {
      try {
        writeTokenFile(lockFile);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        if (Date.now() > deadline) throw timeoutError('exclusive', lockFile);
        await sleep(jitteredBackoff(attempt++));
        continue;
      }
      if (pruneStaleReaders(readersDir) === 0) {
        let released = false;
        return {
          kind: 'exclusive',
          release: () => {
            if (released) return;
            released = true;
            removeQuiet(lockFile);
          },
        };
      }
      // A reader may be mid-registration and not yet have rechecked the
      // marker; give it the benefit of the doubt rather than risk overlap.
      removeQuiet(lockFile);
    }
    if (Date.now() > deadline) throw timeoutError('exclusive', lockFile);
    await sleep(jitteredBackoff(attempt++));
  }
}

/**
 * Safe shared -> exclusive upgrade: release shared first, then acquire
 * exclusive and let the caller recheck the snapshot/manifest (spec section
 * 13). Never holds shared while waiting to upgrade, so two updaters
 * upgrading concurrently cannot deadlock each other.
 */
export async function upgradeToExclusive(
  shared: LockHandle,
  repositoryLockFile: string,
  timeoutSeconds = DEFAULT_LOCK_TIMEOUT_SECONDS,
): Promise<LockHandle> {
  shared.release();
  return acquireExclusive(repositoryLockFile, timeoutSeconds);
}
