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
 * process start time, so a live process's lock is never stolen. Tokens carry
 * a PID-namespace id because a pid means nothing across containers.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFile } from 'node:child_process';
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
  /**
   * Identifies the PID namespace the token was written in (host, boot, pid
   * namespace). A pid is only meaningful inside its own namespace: two
   * containers sharing a bind-mounted .git see unrelated processes under the
   * same numbers. Absent on tokens written by older versions.
   */
  readonly ns?: string;
}

/** A lock written from another PID namespace is only reclaimed once it is this old. */
const FOREIGN_LOCK_MAX_AGE_MS = 60 * 60 * 1000;
/** An unreadable (mid-write or corrupt) token file is left alone until it is this old. */
const UNREADABLE_GRACE_MS = 5_000;
/** A reclaim mutex whose owner crashed is broken after this long. */
const RECLAIM_MUTEX_STALE_MS = 10_000;

let cachedNamespace: string | undefined;
function currentNamespace(): string {
  if (cachedNamespace !== undefined) return cachedNamespace;
  let boot = '';
  let pidns = '';
  try {
    boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    // not Linux
  }
  try {
    pidns = fs.readlinkSync('/proc/self/ns/pid');
  } catch {
    // not Linux, or no permission
  }
  cachedNamespace = `${os.hostname()}|${boot}|${pidns}`;
  return cachedNamespace;
}

/** Linux: field 22 of /proc/<pid>/stat (start time in clock ticks since boot). Synchronous, no fork. */
function procStartTime(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm (field 2) may contain spaces and parens; everything after the last ')' is regular.
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ticks = rest[19]; // field 22 overall = index 19 after pid and comm are removed
    return ticks === undefined ? null : `proc:${ticks}`;
  } catch {
    return null;
  }
}

function psStartTime(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-o', 'lstart=', '-p', String(pid)],
      { encoding: 'utf8', timeout: 5_000 },
      (err, stdout) => {
        if (err) return resolve(null);
        const line = stdout.trim();
        resolve(line.length > 0 ? line : null);
      },
    );
  });
}

/** Never blocks the event loop: /proc where available, an async `ps` elsewhere. */
async function getProcessStartTime(pid: number, preferPs = false): Promise<string | null> {
  if (!preferPs) {
    const fromProc = procStartTime(pid);
    if (fromProc !== null) return fromProc;
  }
  return psStartTime(pid);
}

/**
 * Dead pid, OR alive but not the process that wrote the token (pid reuse after a crash/reboot).
 * A token from a different PID namespace cannot be judged by pid at all, so it is only
 * considered stale once it is very old.
 */
async function isStale(token: LockToken): Promise<boolean> {
  if (token.ns !== undefined && token.ns !== currentNamespace()) {
    return Date.now() - token.acquiredAt > FOREIGN_LOCK_MAX_AGE_MS;
  }
  const recorded = token.startTime;
  const current = await getProcessStartTime(
    token.pid,
    recorded !== '' && !recorded.startsWith('proc:'),
  );
  if (current === null) return true;
  if (recorded === '') return false; // start time was unavailable when the token was written; trust existence.
  return current !== recorded;
}

async function selfToken(): Promise<LockToken> {
  return {
    pid: process.pid,
    startTime: (await getProcessStartTime(process.pid)) ?? '',
    acquiredAt: Date.now(),
    ns: currentNamespace(),
  };
}

/**
 * Create `filePath` with the complete token already inside it, or fail with EEXIST.
 * The token is written to a private temp file and hard-linked into place, so no
 * other process can ever observe an empty or half-written token (which it would
 * mistake for a corrupt one and delete).
 */
async function writeTokenFile(filePath: string): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(await selfToken()), { flag: 'wx' });
  try {
    fs.linkSync(tmp, filePath);
  } finally {
    removeQuiet(tmp);
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

function fileAgeMs(filePath: string): number {
  try {
    return Date.now() - fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Remove an exclusive lock whose owner is gone. Reclaiming is serialised by a
 * short-lived mutex and re-reads the token under it: without that, two
 * processes can both judge the same stale lock, one reclaims it and a third
 * creates a fresh live lock, and the slower judge then deletes the live one.
 */
async function reclaimExclusiveIfStale(lockFile: string): Promise<void> {
  const token = readTokenFile(lockFile);
  if (token === null) return; // absent or unreadable; caller's create-attempt will sort it out
  if (!(await isStale(token))) return;
  const mutex = `${lockFile}.reclaim`;
  if (fileAgeMs(mutex) > RECLAIM_MUTEX_STALE_MS) removeQuiet(mutex);
  let fd: number;
  try {
    fd = fs.openSync(mutex, 'wx');
  } catch {
    return; // someone else is reclaiming; the caller retries
  }
  try {
    const again = readTokenFile(lockFile);
    if (again !== null && again.pid === token.pid && again.acquiredAt === token.acquiredAt) {
      removeQuiet(lockFile);
    }
  } finally {
    fs.closeSync(fd);
    removeQuiet(mutex);
  }
}

async function pruneStaleReaders(readersDir: string): Promise<number> {
  let entries: string[];
  try {
    entries = fs.readdirSync(readersDir);
  } catch {
    return 0;
  }
  let remaining = 0;
  for (const entry of entries) {
    const full = path.join(readersDir, entry);
    if (entry.includes('.tmp-')) {
      // A reader mid-registration; only an abandoned one is removed.
      if (fileAgeMs(full) > UNREADABLE_GRACE_MS) removeQuiet(full);
      continue;
    }
    const token = readTokenFile(full);
    if (token === null) {
      // Unreadable: might be a file that is being replaced right now. Count it as a
      // live reader until it has been unreadable for a while.
      if (fileAgeMs(full) > UNREADABLE_GRACE_MS) removeQuiet(full);
      else remaining++;
      continue;
    }
    if (await isStale(token)) removeQuiet(full);
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
  return {
    lockFile: repositoryLockFile,
    readersDir: path.join(path.dirname(repositoryLockFile), 'readers'),
  };
}

function timeoutError(kind: string, lockFile: string): GitWhyError {
  return new GitWhyError('INDEX_BUSY', `timed out acquiring ${kind} lock on ${lockFile}`, {
    hint: 'another git-why process is using the index; retry, or pass a longer --lock-timeout',
  });
}

/** Acquire shared (reader) access. `timeoutSeconds` defaults to `DEFAULT_LOCK_TIMEOUT_SECONDS`. */
export async function acquireShared(
  repositoryLockFile: string,
  timeoutSeconds = DEFAULT_LOCK_TIMEOUT_SECONDS,
): Promise<LockHandle> {
  const { lockFile, readersDir } = lockPathsFor(repositoryLockFile);
  fs.mkdirSync(readersDir, { recursive: true });
  const deadline = Date.now() + timeoutSeconds * 1000;
  let attempt = 0;
  for (;;) {
    if (fs.existsSync(lockFile)) await reclaimExclusiveIfStale(lockFile);
    if (!fs.existsSync(lockFile)) {
      const readerFile = path.join(
        readersDir,
        `${process.pid}-${crypto.randomBytes(4).toString('hex')}.json`,
      );
      await writeTokenFile(readerFile);
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
export async function acquireExclusive(
  repositoryLockFile: string,
  timeoutSeconds = DEFAULT_LOCK_TIMEOUT_SECONDS,
): Promise<LockHandle> {
  const { lockFile, readersDir } = lockPathsFor(repositoryLockFile);
  fs.mkdirSync(readersDir, { recursive: true });
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const deadline = Date.now() + timeoutSeconds * 1000;
  let attempt = 0;
  for (;;) {
    if (fs.existsSync(lockFile)) await reclaimExclusiveIfStale(lockFile);
    const liveReaders = await pruneStaleReaders(readersDir);
    if (!fs.existsSync(lockFile) && liveReaders === 0) {
      try {
        await writeTokenFile(lockFile);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        if (Date.now() > deadline) throw timeoutError('exclusive', lockFile);
        await sleep(jitteredBackoff(attempt++));
        continue;
      }
      if ((await pruneStaleReaders(readersDir)) === 0) {
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
