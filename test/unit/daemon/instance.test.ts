import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  claimDaemonLock,
  clearInstance,
  daemonHome,
  instanceFile,
  processIsAlive,
  processLooksLikeDaemon,
  readInstance,
  writeInstance,
} from '../../../src/daemon/instance.js';

function withHome<T>(fn: () => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-why-daemon-'));
  const previous = process.env.GIT_WHY_DAEMON_HOME;
  process.env.GIT_WHY_DAEMON_HOME = dir;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.GIT_WHY_DAEMON_HOME;
    else process.env.GIT_WHY_DAEMON_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const record = (overrides: Record<string, unknown> = {}) => ({
  pid: process.pid,
  hostname: os.hostname(),
  token: 'tok',
  url: 'http://127.0.0.1:1234',
  startedAt: new Date().toISOString(),
  ready: true,
  version: '0.1.0',
  ...overrides,
});

test('a record for a live process on this host round-trips', () => {
  withHome(() => {
    writeInstance(record() as never);
    const read = readInstance();
    assert.equal(read?.pid, process.pid);
    assert.equal(read?.url, 'http://127.0.0.1:1234');
  });
});

// The whole point of recording a PID is that the file outlives the process.
// A daemon killed with SIGKILL cannot clean up after itself, and a stale
// record that makes every client hang on a dead socket is worse than having
// no daemon at all.
test('a record naming a dead process is treated as absent and removed', () => {
  withHome(() => {
    // PID 2^22 is above the default pid_max on Linux and macOS, so it cannot
    // be a live process. Using a plausible-but-unused pid would be flaky.
    writeInstance(record({ pid: 4_194_303 }) as never);
    assert.equal(readInstance(), undefined);
    assert.equal(fs.existsSync(instanceFile()), false, 'a dead record must be cleaned up');
  });
});

// The cache directory can sit on a shared or synced filesystem, where another
// machine's PID means nothing here and might collide with a live local one.
test('a record from another host is never trusted', () => {
  withHome(() => {
    writeInstance(record({ hostname: 'some-other-machine' }) as never);
    assert.equal(readInstance(), undefined);
  });
});

test('an unreadable record is reported absent but never deleted (it may be mid-write)', () => {
  withHome(() => {
    fs.mkdirSync(daemonHome(), { recursive: true });
    fs.writeFileSync(instanceFile(), '{not json');
    assert.equal(readInstance(), undefined);
    // Deleting here let a racing client erase a fresh record and orphan its daemon.
    assert.equal(fs.existsSync(instanceFile()), true);
    // The next daemon simply overwrites it, atomically.
    writeInstance(record() as never);
    assert.equal(readInstance()?.pid, process.pid);
  });
});

test('writing the record is atomic: no temp file is left and the old record is replaced whole', () => {
  withHome(() => {
    writeInstance(record({ token: 'one' }) as never);
    writeInstance(record({ token: 'two' }) as never);
    assert.equal(readInstance()?.token, 'two');
    assert.deepEqual(
      fs.readdirSync(daemonHome()).filter((f) => f.endsWith('.tmp')),
      [],
    );
  });
});

test('a late shutdown cannot clear a successor daemon record', () => {
  withHome(() => {
    writeInstance(record({ pid: process.pid + 1 }) as never);
    clearInstance(); // we are not that pid
    assert.equal(fs.existsSync(instanceFile()), true);
  });
});

test('only one daemon can claim the daemon lock; a dead owner is evicted', () => {
  withHome(() => {
    const first = claimDaemonLock();
    assert.ok(first, 'first claim succeeds');
    assert.equal(claimDaemonLock(), undefined, 'a second live claimant is refused');
    first();
    const again = claimDaemonLock();
    assert.ok(again, 'released lock can be claimed again');
    again();
    // A crashed daemon leaves its lock behind; a dead pid must not block start-up forever.
    fs.writeFileSync(
      path.join(daemonHome(), 'daemon.lock'),
      JSON.stringify({ pid: 4_194_303, hostname: os.hostname() }),
    );
    const evicting = claimDaemonLock();
    assert.ok(evicting);
    evicting();
  });
});

test('processLooksLikeDaemon refuses an unrelated process, so a reused pid is never signalled', () => {
  assert.equal(processLooksLikeDaemon(process.pid), false); // the test runner is not `server run`
  assert.equal(processLooksLikeDaemon(4_194_303), false);
});

test('a missing record is absent, not an error', () => {
  withHome(() => {
    assert.equal(readInstance(), undefined);
    assert.doesNotThrow(() => clearInstance());
  });
});

test('the record is written private to the user', () => {
  withHome(() => {
    writeInstance(record() as never);
    // It carries the bearer token, so "can you read this file" is the
    // authorisation check. World-readable would make it no check at all.
    const mode = fs.statSync(instanceFile()).mode & 0o777;
    assert.equal(mode & 0o077, 0, `expected no group/other bits, got ${mode.toString(8)}`);
  });
});

test('processIsAlive agrees with reality for this process', () => {
  assert.equal(processIsAlive(process.pid), true);
  assert.equal(processIsAlive(4_194_303), false);
});
