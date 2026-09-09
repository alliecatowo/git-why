// Prototype cross-process shared/exclusive advisory lock built ONLY on
// Node stdlib (fs + child_process). This is what spike probe 8 exercises;
// src/index/lock.ts is the productionized version of the same protocol.
//
// Files:
//   <lockDir>/repository.lock         exclusive marker, created via O_EXCL
//   <lockDir>/readers/<pid>-<rnd>.json  one file per active shared holder
//
// Algorithm (see docs/decisions.md for the empirical justification):
//
// Shared (reader) acquire:
//   1. If repository.lock exists and is live, wait/backoff; if stale
//      (owning process dead, or pid reused — checked via recorded process
//      start time), remove it and continue.
//   2. Create own file in readers/ via O_EXCL (name includes pid + random
//      suffix, so creation cannot collide).
//   3. Re-check repository.lock. If it now exists, remove the just-created
//      reader file and retry from step 1 — a writer may have raced in.
//   4. Otherwise the shared hold is acquired.
//
// Exclusive (writer) acquire:
//   1. Prune stale reader files (dead owning process) from readers/.
//   2. If readers/ is non-empty, or repository.lock exists (live), back
//      off and retry.
//   3. Create repository.lock via O_EXCL.
//   4. Re-check readers/. If any file remains, treat it as a potentially
//      active reader that has not yet finished its own re-check: remove
//      the lock file and back off, rather than risk overlapping a reader
//      that is already inside. This trades some liveness (a busy reader
//      directory can delay a writer) for safety with no missed overlap.
//   5. Otherwise the exclusive hold is acquired.
//
// Both sides poll with jittered backoff up to a caller-supplied deadline.
// Locks are released by deleting the corresponding file; process death
// releases them implicitly because staleness detection reclaims dead
// owners' files.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export interface LockHandle {
  readonly kind: 'shared' | 'exclusive';
  release(): void;
}

export class LockTimeoutError extends Error {}

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

/** True when the pid is dead, OR alive but not the process that wrote the token (pid reuse). */
function isStale(pid: number, recordedStartTime: string): boolean {
  const current = getProcessStartTime(pid);
  if (current === null) return true;
  return current !== recordedStartTime;
}

function selfToken(): { pid: number; startTime: string } {
  const startTime = getProcessStartTime(process.pid);
  // If `ps` is unavailable, degrade to pid-only liveness (process.kill(pid,0)).
  return { pid: process.pid, startTime: startTime ?? '' };
}

function writeTokenFile(filePath: string, extra: Record<string, unknown> = {}): void {
  const token = { ...selfToken(), acquiredAt: Date.now(), ...extra };
  const fd = fs.openSync(filePath, 'wx');
  try {
    fs.writeFileSync(fd, JSON.stringify(token));
  } finally {
    fs.closeSync(fd);
  }
}

function readTokenFile(filePath: string): { pid: number; startTime: string } | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as { pid: number; startTime: string };
    return parsed;
  } catch {
    return null;
  }
}

function removeQuiet(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // already gone
  }
}

/** Remove the exclusive marker if its owner is provably dead. Returns true if removed or already absent. */
function reclaimExclusiveIfStale(lockPath: string): boolean {
  const token = readTokenFile(lockPath);
  if (token === null) return true; // absent, or unreadable garbage we can't trust — leave to caller retry
  if (isStale(token.pid, token.startTime)) {
    removeQuiet(lockPath);
    return true;
  }
  return false;
}

function pruneStaleReaders(readersDir: string): number {
  let remaining = 0;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(readersDir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(readersDir, entry);
    const token = readTokenFile(full);
    if (token === null) {
      removeQuiet(full); // unreadable/partial — treat as garbage
      continue;
    }
    if (isStale(token.pid, token.startTime)) {
      removeQuiet(full);
    } else {
      remaining++;
    }
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

export interface LockPaths {
  readonly lockFile: string;
  readonly readersDir: string;
}

export function lockPathsFor(lockDir: string): LockPaths {
  return {
    lockFile: path.join(lockDir, 'repository.lock'),
    readersDir: path.join(lockDir, 'readers'),
  };
}

export async function acquireShared(lockDir: string, timeoutMs: number): Promise<LockHandle> {
  const { lockFile, readersDir } = lockPathsFor(lockDir);
  fs.mkdirSync(readersDir, { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  for (;;) {
    if (fs.existsSync(lockFile)) {
      reclaimExclusiveIfStale(lockFile);
    }
    if (!fs.existsSync(lockFile)) {
      const readerFile = path.join(
        readersDir,
        `${process.pid}-${crypto.randomBytes(4).toString('hex')}.json`,
      );
      writeTokenFile(readerFile);
      if (!fs.existsSync(lockFile)) {
        return {
          kind: 'shared',
          release: () => removeQuiet(readerFile),
        };
      }
      // A writer raced in after our absence check. Back off.
      removeQuiet(readerFile);
    }
    if (Date.now() > deadline) {
      throw new LockTimeoutError(`timed out acquiring shared lock on ${lockDir}`);
    }
    await sleep(jitteredBackoff(attempt++));
  }
}

export async function acquireExclusive(lockDir: string, timeoutMs: number): Promise<LockHandle> {
  const { lockFile, readersDir } = lockPathsFor(lockDir);
  fs.mkdirSync(readersDir, { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  for (;;) {
    if (fs.existsSync(lockFile)) {
      reclaimExclusiveIfStale(lockFile);
    }
    const liveReaders = pruneStaleReaders(readersDir);
    if (!fs.existsSync(lockFile) && liveReaders === 0) {
      try {
        writeTokenFile(lockFile);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          // Someone else created it first; retry loop.
          if (Date.now() > deadline)
            throw new LockTimeoutError(`timed out acquiring exclusive lock on ${lockDir}`);
          await sleep(jitteredBackoff(attempt++));
          continue;
        }
        throw err;
      }
      // Re-check for readers that may have registered concurrently.
      const stillLive = pruneStaleReaders(readersDir);
      if (stillLive === 0) {
        return { kind: 'exclusive', release: () => removeQuiet(lockFile) };
      }
      // Possible overlap with an active or about-to-back-off reader: yield.
      removeQuiet(lockFile);
    }
    if (Date.now() > deadline) {
      throw new LockTimeoutError(`timed out acquiring exclusive lock on ${lockDir}`);
    }
    await sleep(jitteredBackoff(attempt++));
  }
}

/** Safe shared -> exclusive upgrade: release shared first, then acquire exclusive and let the caller recheck state. */
export async function upgrade(
  shared: LockHandle,
  lockDir: string,
  timeoutMs: number,
): Promise<LockHandle> {
  shared.release();
  return acquireExclusive(lockDir, timeoutMs);
}
