/**
 * Daemon discovery: one record on disk saying whether a daemon is running,
 * where to reach it, and whether it is ready.
 *
 * Mirrors `zg`'s `DaemonInstanceLock`, including the part that matters most:
 * liveness is decided by signalling the recorded PID, not by the file
 * existing. A daemon killed with SIGKILL leaves its record behind, and a stale
 * record that makes every client hang on a dead socket is worse than no daemon
 * at all.
 *
 * The record lives beside the model cache rather than inside any repository,
 * because one daemon serves every repository on the machine.
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveCacheRoot } from '../embedding/cache.js';

export interface InstanceRecord {
  readonly pid: number;
  readonly hostname: string;
  /** Proves a control request came from whoever started this daemon. */
  readonly token: string;
  readonly url: string;
  readonly startedAt: string;
  readonly ready: boolean;
  readonly version: string;
}

/**
 * Beside the model cache, not inside any repository: one daemon serves every
 * repository on the machine, so its record cannot live in `.git/`.
 */
export function daemonHome(): string {
  if (process.env.GIT_WHY_DAEMON_HOME) return process.env.GIT_WHY_DAEMON_HOME;
  // resolveCacheRoot points at `<cache>/git-why/models`; the daemon is a
  // sibling of the models, under the same per-user cache directory.
  return path.join(path.dirname(resolveCacheRoot()), 'daemon');
}

export function instanceFile(): string {
  return path.join(daemonHome(), 'instance.json');
}

/** Signal 0 tests for existence without touching the process. */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and belongs to another user, which still counts.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Reads the record, returning undefined when no daemon is usable.
 *
 * A record naming a dead PID is removed rather than returned, so the next
 * `server on` does not have to reason about leftovers. A record from another
 * host is never trusted: the cache directory may be on a shared filesystem,
 * and that PID means nothing here.
 */
export function readInstance(): InstanceRecord | undefined {
  let raw: string;
  try {
    raw = readFileSync(instanceFile(), 'utf8');
  } catch {
    return undefined;
  }
  let record: InstanceRecord;
  try {
    record = JSON.parse(raw) as InstanceRecord;
  } catch {
    // Never delete on a parse error: a record that is unreadable this instant may be
    // one a daemon just wrote, and removing it would orphan a healthy daemon. Writes are
    // atomic (rename), so a genuinely corrupt file is simply overwritten by the next
    // daemon that starts.
    return undefined;
  }
  if (record.hostname !== hostname()) return undefined;
  if (!Number.isInteger(record.pid) || !processIsAlive(record.pid)) {
    // Remove the stale record only if it is still the one we judged; a new daemon may
    // have replaced it since we read it.
    try {
      if (readFileSync(instanceFile(), 'utf8') === raw) rmSync(instanceFile(), { force: true });
    } catch {
      /* already gone */
    }
    return undefined;
  }
  return record;
}

export function writeInstance(record: InstanceRecord): void {
  mkdirSync(daemonHome(), { recursive: true });
  const temp = `${instanceFile()}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  // Rename is atomic: a client reads the old record or the new one, never a half-written one.
  renameSync(temp, instanceFile());
}

/**
 * Whether `pid` still looks like a git-why daemon rather than an unrelated process that
 * reused the number after a crash or reboot. Used before signalling: when it cannot be
 * determined the answer is false, because killing a stranger is worse than leaving a
 * stale daemon for the user to stop.
 */
export function processLooksLikeDaemon(pid: number): boolean {
  let command: string | null = null;
  try {
    command = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ');
  } catch {
    try {
      command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      });
    } catch {
      return false;
    }
  }
  return /\bserver\b/.test(command) && /\brun\b/.test(command);
}

function startLockFile(): string {
  return path.join(daemonHome(), 'daemon.lock');
}

/**
 * Claims the right to run the daemon, atomically (O_EXCL). Two concurrent `server on`
 * used to produce two daemons, the second overwriting the first's record and orphaning
 * it. Returns a release function, or undefined when a live daemon already holds it.
 */
export function claimDaemonLock(): (() => void) | undefined {
  mkdirSync(daemonHome(), { recursive: true });
  const file = startLockFile();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, hostname: hostname() }));
      closeSync(fd);
      return () => {
        try {
          const owner = JSON.parse(readFileSync(file, 'utf8')) as { pid?: number };
          if (owner.pid === process.pid) rmSync(file, { force: true });
        } catch {
          /* already gone */
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    let owner: { pid?: number; hostname?: string } | null = null;
    try {
      owner = JSON.parse(readFileSync(file, 'utf8')) as { pid?: number; hostname?: string };
    } catch {
      owner = null; // being written right now, or corrupt: look again shortly
    }
    if (owner !== null && owner.hostname === hostname() && owner.pid !== undefined) {
      if (processIsAlive(owner.pid)) return undefined;
      rmSync(file, { force: true }); // its owner is gone
    } else if (owner !== null && owner.hostname !== hostname()) {
      return undefined; // another host's daemon on a shared filesystem: not ours to evict
    }
  }
  return undefined;
}

/** Removes the record only if it is ours, so a late shutdown cannot erase a successor's. */
export function clearInstance(): void {
  try {
    const record = JSON.parse(readFileSync(instanceFile(), 'utf8')) as { pid?: number };
    if (record.pid !== process.pid) return;
  } catch {
    // unreadable: fall through and remove, there is nothing of anyone's to protect
  }
  rmSync(instanceFile(), { force: true });
}

export function newToken(): string {
  return randomUUID();
}
