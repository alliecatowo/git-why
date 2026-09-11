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

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    rmSync(instanceFile(), { force: true });
    return undefined;
  }
  if (record.hostname !== hostname()) return undefined;
  if (!Number.isInteger(record.pid) || !processIsAlive(record.pid)) {
    rmSync(instanceFile(), { force: true });
    return undefined;
  }
  return record;
}

export function writeInstance(record: InstanceRecord): void {
  mkdirSync(daemonHome(), { recursive: true });
  const temp = `${instanceFile()}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  // Rename so a client never reads a half-written record.
  writeFileSync(instanceFile(), readFileSync(temp), { mode: 0o600 });
  rmSync(temp, { force: true });
}

export function clearInstance(): void {
  rmSync(instanceFile(), { force: true });
}

export function newToken(): string {
  return randomUUID();
}
