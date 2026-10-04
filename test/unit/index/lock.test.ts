import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireExclusive, acquireShared } from '../../../src/index/lock.js';
import { GitWhyError } from '../../../src/types.js';

function tmp(): { lockFile: string; readersDir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-why-lock-unit-'));
  return { lockFile: path.join(dir, 'repo.lock'), readersDir: path.join(dir, 'readers') };
}

const DEAD_PID = 2 ** 22 + 4242;

test('a lock left by a dead process on this host is reclaimed', async () => {
  const { lockFile } = tmp();
  fs.writeFileSync(lockFile, JSON.stringify({ pid: DEAD_PID, startTime: 'x', acquiredAt: 1 }));
  const handle = await acquireExclusive(lockFile, 2);
  handle.release();
  assert.equal(fs.existsSync(lockFile), false);
});

test('a lock from another PID namespace is not judged by its pid, so a live container keeps it', async () => {
  const { lockFile } = tmp();
  // The pid does not exist here, but the token says it was written elsewhere (another container).
  fs.writeFileSync(
    lockFile,
    JSON.stringify({
      pid: DEAD_PID,
      startTime: 'proc:1',
      acquiredAt: Date.now(),
      ns: 'other-host|other-boot|pid:[4026539999]',
    }),
  );
  await assert.rejects(
    () => acquireExclusive(lockFile, 0.3),
    (err: unknown) => err instanceof GitWhyError && err.code === 'INDEX_BUSY',
  );
  assert.equal(fs.existsSync(lockFile), true);
  // Shared access is refused too while that writer is presumed alive.
  await assert.rejects(
    () => acquireShared(lockFile, 0.3),
    (err: unknown) => err instanceof GitWhyError && err.code === 'INDEX_BUSY',
  );
});

test('a reader token that is mid-write (unreadable) is not pruned out from under its owner', async () => {
  const { lockFile, readersDir } = tmp();
  fs.mkdirSync(readersDir, { recursive: true });
  const partial = path.join(readersDir, '99999-deadbeef.json');
  fs.writeFileSync(partial, '{"pid":'); // torn, as a reader that has not finished writing looks
  await assert.rejects(
    () => acquireExclusive(lockFile, 0.3),
    (err: unknown) => err instanceof GitWhyError && err.code === 'INDEX_BUSY',
  );
  assert.equal(fs.existsSync(partial), true, 'the in-flight reader must survive the writer probe');
});

test('registering a reader never exposes a partial token and leaves no temp files behind', async () => {
  const { lockFile, readersDir } = tmp();
  const handle = await acquireShared(lockFile, 2);
  const files = fs.readdirSync(readersDir);
  assert.equal(files.length, 1);
  assert.ok(files.every((f) => !f.includes('.tmp-')));
  const token = JSON.parse(fs.readFileSync(path.join(readersDir, files[0] as string), 'utf8')) as {
    pid: number;
    ns?: string;
  };
  assert.equal(token.pid, process.pid);
  assert.equal(typeof token.ns, 'string');
  handle.release();
  assert.deepEqual(fs.readdirSync(readersDir), []);
});

test('exclusive access is mutually exclusive under contention', async () => {
  const { lockFile } = tmp();
  let inside = 0;
  let maxInside = 0;
  await Promise.all(
    Array.from({ length: 12 }, async () => {
      const handle = await acquireExclusive(lockFile, 20);
      inside++;
      maxInside = Math.max(maxInside, inside);
      await new Promise((r) => setTimeout(r, 5));
      inside--;
      handle.release();
    }),
  );
  assert.equal(maxInside, 1);
});

test('a stale-lock reclaim race does not delete a live replacement lock', async () => {
  const { lockFile } = tmp();
  fs.writeFileSync(lockFile, JSON.stringify({ pid: DEAD_PID, startTime: 'x', acquiredAt: 1 }));
  // Many contenders all see the same stale lock; exactly one at a time may hold it afterwards.
  let inside = 0;
  let maxInside = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      const handle = await acquireExclusive(lockFile, 20);
      inside++;
      maxInside = Math.max(maxInside, inside);
      await new Promise((r) => setTimeout(r, 5));
      inside--;
      handle.release();
    }),
  );
  assert.equal(maxInside, 1);
});
