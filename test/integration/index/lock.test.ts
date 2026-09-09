import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireExclusive, acquireShared } from '../../../src/index/lock.js';
import { GitWhyError } from '../../../src/types.js';
import { freshTmpDir, rmDir } from './helpers.js';
import { childSpawnArgs } from './child-script.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const childArgs = childSpawnArgs(here, repoRoot, 'lock-child');

function runChild(
  lockFile: string,
  kind: 'shared' | 'exclusive',
  timeoutSeconds: number,
  holdMs: number,
) {
  return new Promise<{ lines: Record<string, unknown>[]; code: number | null }>((resolve) => {
    const child = spawn(process.execPath, [
      ...childArgs,
      lockFile,
      kind,
      String(timeoutSeconds),
      String(holdMs),
    ]);
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('close', (code) =>
      resolve({
        code,
        lines: out
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>),
      }),
    );
  });
}

function spawnChildRaw(
  lockFile: string,
  kind: 'shared' | 'exclusive',
  timeoutSeconds: number,
  holdMs: number,
) {
  return spawn(process.execPath, [
    ...childArgs,
    lockFile,
    kind,
    String(timeoutSeconds),
    String(holdMs),
  ]);
}

test('exclusive lock: acquire, hold, release, then a second process reacquires', async () => {
  const dir = freshTmpDir('lock-exclusive');
  const lockFile = path.join(dir, 'repository.lock');
  try {
    const first = await runChild(lockFile, 'exclusive', 5, 200);
    const second = await runChild(lockFile, 'exclusive', 5, 100);
    assert.ok(first.lines.some((l) => l.event === 'acquired'));
    assert.ok(first.lines.some((l) => l.event === 'released'));
    assert.ok(second.lines.some((l) => l.event === 'acquired'));
  } finally {
    rmDir(dir);
  }
});

test('two shared locks are acquired concurrently without waiting on each other', async () => {
  const dir = freshTmpDir('lock-shared');
  const lockFile = path.join(dir, 'repository.lock');
  try {
    const [a, b] = await Promise.all([
      runChild(lockFile, 'shared', 5, 300),
      runChild(lockFile, 'shared', 5, 300),
    ]);
    const aAcq = a.lines.find((l) => l.event === 'acquired') as { waitedMs: number } | undefined;
    const bAcq = b.lines.find((l) => l.event === 'acquired') as { waitedMs: number } | undefined;
    assert.ok(aAcq && bAcq);
    assert.ok(aAcq.waitedMs < 250, `expected fast shared acquisition, waited ${aAcq.waitedMs}ms`);
    assert.ok(bAcq.waitedMs < 250, `expected fast shared acquisition, waited ${bAcq.waitedMs}ms`);
  } finally {
    rmDir(dir);
  }
});

test('an exclusive holder blocks a concurrent shared request until it releases', async () => {
  const dir = freshTmpDir('lock-exclusive-blocks-shared');
  const lockFile = path.join(dir, 'repository.lock');
  try {
    const exclusivePromise = runChild(lockFile, 'exclusive', 5, 500);
    await new Promise((r) => setTimeout(r, 100));
    const shared = await runChild(lockFile, 'shared', 5, 50);
    await exclusivePromise;
    const sharedAcq = shared.lines.find((l) => l.event === 'acquired') as
      { waitedMs: number } | undefined;
    assert.ok(sharedAcq, 'shared request should eventually succeed');
    assert.ok(
      sharedAcq.waitedMs >= 300,
      `shared request should have waited out most of the exclusive hold, only waited ${sharedAcq.waitedMs}ms`,
    );
  } finally {
    rmDir(dir);
  }
});

test('a live exclusive holder is never stolen by a short --lock-timeout: INDEX_BUSY is raised instead', async () => {
  const dir = freshTmpDir('lock-timeout');
  const lockFile = path.join(dir, 'repository.lock');
  try {
    const holder = await acquireExclusive(lockFile, 30);
    try {
      await assert.rejects(
        () => acquireExclusive(lockFile, 0.3),
        (err: unknown) => err instanceof GitWhyError && err.code === 'INDEX_BUSY',
      );
    } finally {
      holder.release();
    }
  } finally {
    rmDir(dir);
  }
});

test('a SIGKILLed exclusive holder is reclaimed by staleness detection, not a timer', async () => {
  const dir = freshTmpDir('lock-sigkill');
  const lockFile = path.join(dir, 'repository.lock');
  try {
    const holder = spawnChildRaw(lockFile, 'exclusive', 5, 60_000);
    let out = '';
    await new Promise<void>((resolve) => {
      holder.stdout.on('data', (d) => {
        out += d.toString();
        if (out.includes('"acquired"')) resolve();
      });
    });
    holder.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 150));

    const t0 = Date.now();
    const second = await acquireExclusive(lockFile, 5);
    const waitedMs = Date.now() - t0;
    second.release();
    assert.ok(waitedMs < 2000, `expected fast reclaim of a dead holder's lock, took ${waitedMs}ms`);
  } finally {
    rmDir(dir);
  }
});

test('shared -> exclusive upgrade releases shared first (never holds both) and lets two upgraders proceed without deadlock', async () => {
  const dir = freshTmpDir('lock-upgrade');
  const lockFile = path.join(dir, 'repository.lock');
  try {
    const sharedA = await acquireShared(lockFile, 5);
    const sharedB = await acquireShared(lockFile, 5);
    // Both release before upgrading, exactly as src/index/lock.ts's
    // upgradeToExclusive does internally — modeled here directly against
    // acquireExclusive to prove neither upgrade attempt can deadlock the
    // other, since at no point does either side hold shared while waiting.
    sharedA.release();
    sharedB.release();

    // Each upgrader briefly holds exclusive access and releases it — like
    // two real updaters completing their reconciliation in turn — so this
    // proves serialized, deadlock-free progress rather than two processes
    // both permanently blocked (which a naive "hold shared while waiting to
    // upgrade" implementation would produce).
    async function upgradeHoldRelease(): Promise<void> {
      const handle = await acquireExclusive(lockFile, 10);
      await new Promise((r) => setTimeout(r, 50));
      handle.release();
    }
    const [a, b] = await Promise.allSettled([upgradeHoldRelease(), upgradeHoldRelease()]);
    for (const r of [a, b]) {
      if (r.status === 'rejected')
        assert.fail(`upgrader should not deadlock or time out: ${String(r.reason)}`);
    }
  } finally {
    rmDir(dir);
  }
});
