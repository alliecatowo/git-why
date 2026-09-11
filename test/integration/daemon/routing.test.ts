/**
 * The property that makes `auto` safe as the default: a daemon can never be
 * the reason a search fails.
 *
 * These drive the real CLI as a child process against the real daemon, because
 * the failure modes being tested are process-level — a daemon that was killed,
 * a record left behind by one that cannot clean up after itself, a socket
 * nobody is listening on. None of that is reachable from an in-process fake.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createTestRepo, type TestRepo } from '../../fixtures/repo.js';

// Resolved relative to this compiled test, the same way the CLI integration
// suite does it: the assets are copied next to the compiled tests, not left
// at a path that can be composed from the repository root.
const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const CLI = path.join(repoRoot, 'dist', 'cli', 'main.js');
const fakeBackendUrl = pathToFileURL(
  path.join(import.meta.dirname, '..', 'cli', 'fixtures', 'fake-backend.mjs'),
).href;
const typesModuleUrl = pathToFileURL(path.join(repoRoot, 'dist', 'types.js')).href;

let home: string;
let repo: TestRepo;

const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [CLI, ...args], {
    cwd: repo.dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_WHY_DAEMON_HOME: home,
      GIT_WHY_TEST_BACKEND: fakeBackendUrl,
      GIT_WHY_TYPES_MODULE: typesModuleUrl,
      GIT_WHY_TEST_CONFIG: '{}',
      NO_COLOR: '1',
      ...env,
    },
  });

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'git-why-daemon-it-'));
  repo = await createTestRepo();
});

after(async () => {
  run(['server', 'off']);
  await repo.cleanup();
  fs.rmSync(home, { recursive: true, force: true });
});

test('with no daemon, status says so and --check-ready fails', () => {
  const status = run(['server', 'status']);
  assert.equal(status.status, 0);
  assert.match(status.stdout, /not running/);
  assert.notEqual(run(['server', 'status', '--check-ready']).status, 0);
});

test('auto works with no daemon running', () => {
  const result = run(['fake query', '--json', '--daemon=auto']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).results.length, 1);
});

test('server mode fails loudly when there is no daemon, rather than silently going direct', () => {
  const result = run(['fake query', '--json', '--daemon=server']);
  assert.notEqual(result.status, 0);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.error.code, 'INVALID_ARGUMENTS');
  assert.match(envelope.error.message, /no daemon/);
  // The hint must name the flag that actually exists.
  assert.match(envelope.error.hint, /git why server on/);
});

test('a record left by a killed daemon does not break auto, and is cleaned up', () => {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, 'instance.json'),
    JSON.stringify({
      pid: 4_194_303,
      hostname: os.hostname(),
      token: 'stale',
      url: 'http://127.0.0.1:9',
      startedAt: new Date().toISOString(),
      ready: true,
      version: '0.0.0',
    }),
  );
  const result = run(['fake query', '--json', '--daemon=auto']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).results.length, 1);
  assert.equal(
    fs.existsSync(path.join(home, 'instance.json')),
    false,
    'a record naming a dead process must be removed, not left to slow every later call',
  );
});

test('a record pointing at a port nobody is listening on falls back rather than hanging', () => {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, 'instance.json'),
    JSON.stringify({
      // This process is alive, so liveness passes and the health check is what
      // has to catch it — the case a PID check alone would miss.
      pid: process.pid,
      hostname: os.hostname(),
      token: 'stale',
      url: 'http://127.0.0.1:9',
      startedAt: new Date().toISOString(),
      ready: true,
      version: '0.0.0',
    }),
  );
  const result = run(['fake query', '--json', '--daemon=auto']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).results.length, 1);
  fs.rmSync(path.join(home, 'instance.json'), { force: true });
});

// A daemon serves every repository on the machine. A request it cannot satisfy
// must be answered with an error, not by dying — this one killed it outright:
// the open path attached its cleanup with `.finally()`, which produced a
// promise carrying the rejection that nothing awaited, and an unhandled
// rejection terminates the process. One `git why` in an unindexed clone took
// down the warm state of every other repository.
test('a request the daemon cannot satisfy does not take the daemon down', async () => {
  const started = run(['server', 'on']);
  assert.equal(started.status, 0, started.stderr);
  try {
    const before = JSON.parse(run(['server', 'status', '--json']).stdout);
    assert.equal(before.ready, true);

    // The fake backend is bypassed for daemon-served requests, so this reaches
    // the real code path against a repository that genuinely has no index.
    const failed = run(['some question', '--json', '--no-refresh', '--daemon=server']);
    assert.notEqual(failed.status, 0, 'an unindexed repository must be an error');

    const after = JSON.parse(run(['server', 'status', '--json']).stdout);
    assert.equal(after.ready, true, 'the daemon must still be serving');
    assert.equal(after.pid, before.pid, 'and must be the same process, not a restarted one');
  } finally {
    run(['server', 'off']);
  }
});
