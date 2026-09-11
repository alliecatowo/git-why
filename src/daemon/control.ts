/**
 * `git why server on|off|status|run` — the lifecycle surface.
 *
 * `on` spawns a detached child running `run`, then waits for it to become
 * reachable rather than assuming it will. A "started" message that precedes
 * readiness is how a script ends up racing its own daemon.
 */

import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitWhyError } from '../types.js';
import { connect, discover, type DaemonConnection } from './client.js';
import { daemonHome, readInstance } from './instance.js';

export interface ServerStatus {
  readonly running: boolean;
  readonly ready: boolean;
  readonly pid?: number;
  readonly url?: string;
  readonly version?: string;
  readonly uptimeMs?: number;
  readonly repositories?: number;
  readonly servedRequests?: number;
}

export async function serverStatus(): Promise<ServerStatus> {
  const record = readInstance();
  if (record === undefined) return { running: false, ready: false };
  try {
    const health = await connect(record).health();
    return {
      running: true,
      ready: true,
      pid: record.pid,
      url: record.url,
      version: health.version,
      uptimeMs: health.uptimeMs,
      repositories: health.repositories,
      servedRequests: health.servedRequests,
    };
  } catch {
    // The record names a live process that is not answering. That is running
    // but not ready, and the distinction matters to `--check-ready`.
    return { running: true, ready: false, pid: record.pid, url: record.url };
  }
}

function cliEntry(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'main.js');
}

export async function startServer(options: { timeoutMs?: number } = {}): Promise<ServerStatus> {
  const existing = await serverStatus();
  if (existing.running && existing.ready) return existing;

  const home = daemonHome();
  mkdirSync(path.join(home, 'logs'), { recursive: true });
  const logFile = path.join(home, 'logs', 'server.log');
  const out = openSync(logFile, 'a');

  const child = spawn(process.execPath, [cliEntry(), 'server', 'run'], {
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env,
  });
  child.unref();

  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  // Poll rather than trust: the child writes its record only once it is
  // actually listening, so reachability is the readiness signal.
  for (;;) {
    const status = await serverStatus();
    if (status.ready) return status;
    if (Date.now() > deadline) {
      throw new GitWhyError('INTERNAL', 'the daemon did not become ready in time', {
        hint: `check ${logFile}`,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function stopServer(): Promise<ServerStatus> {
  const record = readInstance();
  if (record === undefined) return { running: false, ready: false };
  let connection: DaemonConnection | undefined;
  try {
    connection = await discover();
  } catch {
    connection = undefined;
  }
  if (connection !== undefined) {
    try {
      await connection.shutdown();
    } catch {
      // It may have closed the socket before answering, which is success.
    }
  } else {
    // Not answering, but the PID is alive: ask it to exit rather than leaving
    // a process holding shared locks on every index it has open.
    try {
      process.kill(record.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  for (let i = 0; i < 50; i++) {
    if (readInstance() === undefined) return { running: false, ready: false };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { running: true, ready: false, pid: record.pid, url: record.url };
}
