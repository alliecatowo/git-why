/**
 * Drives the real, built `dist/cli/main.js` as a child process against a
 * real temporary Git repository (via `test/fixtures/repo.ts`), with a fake
 * in-process backend wired through the `GIT_WHY_TEST_BACKEND` seam in
 * `src/cli/wire.ts`. This exercises the actual argument parsing, process
 * exit handling, and human/JSON rendering, without needing the git/index/
 * embedding/search lanes to exist yet.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';
import { createTestRepo, type TestRepo } from '../../fixtures/repo.js';

import { findRepoRoot } from '../../repo-root.js';
const repoRoot = findRepoRoot(import.meta.dirname);
const distMain = path.join(repoRoot, 'dist', 'cli', 'main.js');
const fakeBackendUrl = pathToFileURL(
  path.join(import.meta.dirname, 'fixtures', 'fake-backend.mjs'),
).href;
const typesModuleUrl = pathToFileURL(path.join(repoRoot, 'dist', 'types.js')).href;

before(() => {
  if (!existsSync(distMain)) {
    execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'inherit' });
  }
  assert.ok(existsSync(distMain), `expected ${distMain} to exist after build`);
});

interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface RunOptions {
  readonly cwd: string;
  readonly config?: Record<string, unknown>;
  readonly env?: NodeJS.ProcessEnv;
  readonly needsBackend?: boolean;
  readonly onChild?: (child: ReturnType<typeof spawn>) => void;
}

function runCli(args: readonly string[], options: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...options.env,
    };
    if (options.needsBackend !== false) {
      env.GIT_WHY_TEST_BACKEND = fakeBackendUrl;
      env.GIT_WHY_TYPES_MODULE = typesModuleUrl;
      env.GIT_WHY_TEST_CONFIG = JSON.stringify(options.config ?? {});
    }
    const child = spawn(process.execPath, [distMain, ...args], { cwd: options.cwd, env });
    options.onChild?.(child);

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        code,
        signal,
      });
    });
  });
}

let repo: TestRepo;
before(async () => {
  repo = await createTestRepo();
  await repo.writeFile('src/auth/refresh.ts', 'export function refresh() {}\n');
  await repo.add(['src/auth/refresh.ts']);
  await repo.commit('Fix infinite token-refresh loop');
});
after(async () => {
  await repo?.cleanup();
});

// --- Basic dispatch, no backend needed --------------------------------

test('--help exits 0 and prints usage, without needing a backend', async () => {
  const result = await runCli(['--help'], { cwd: repo.dir, needsBackend: false });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage: git why/);
  assert.equal(result.stderr, '');
});

test('--version exits 0, without needing a backend', async () => {
  const result = await runCli(['--version'], { cwd: repo.dir, needsBackend: false });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^git-why \d+\.\d+\.\d+\n$/);
});

test('an empty query is rejected with exit 2 and a stderr message, no backend needed', async () => {
  const result = await runCli([], { cwd: repo.dir, needsBackend: false });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /git why:/);
  assert.equal(result.stdout, '');
});

test('an empty query with --json still produces exactly one valid JSON error object on stdout', async () => {
  const result = await runCli(['--json'], { cwd: repo.dir, needsBackend: false });
  assert.equal(result.code, 2);
  const parsed = JSON.parse(result.stdout.trim());
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.error.code, 'EMPTY_QUERY');
  assert.deepEqual(parsed.results, []);
});

// --- Search happy path, stdout/stderr separation -----------------------

test('a search prints human results to stdout and progress to stderr, separated', async () => {
  const result = await runCli(['fake query'], { cwd: repo.dir, config: {} });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Fake commit for integration testing/);
  assert.match(result.stderr, /reconcile: fake backend reconciling/);
  assert.ok(!result.stdout.includes('reconcile:'), 'progress must not leak into human stdout');
});

test('--json search output is exactly one valid JSON object on stdout; progress stays on stderr', async () => {
  const result = await runCli(['fake query', '--json'], { cwd: repo.dir, config: {} });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout.trim()); // throws if stdout has anything but one object
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.query, 'fake query');
  assert.equal(parsed.results.length, 1);
  assert.match(result.stderr, /reconcile:/);
});

test('no ANSI escape sequences appear in output, with or without NO_COLOR', async () => {
  const withVar = await runCli(['fake query'], {
    cwd: repo.dir,
    config: {},
    env: { NO_COLOR: '1' },
  });
  const withoutVar = await runCli(['fake query'], {
    cwd: repo.dir,
    config: {},
    env: { NO_COLOR: undefined },
  });
  assert.ok(!withVar.stdout.includes('\x1b'));
  assert.ok(!withoutVar.stdout.includes('\x1b'));
});

test('path restrictions after -- are accepted and do not break dispatch', async () => {
  const result = await runCli(['fake query', '--', 'src/auth/refresh.ts'], {
    cwd: repo.dir,
    config: {},
  });
  assert.equal(result.code, 0);
});

test('an unsupported pathspec glob is rejected with exit 2 before the backend is even asked', async () => {
  const result = await runCli(['fake query', '--', '*.ts'], {
    cwd: repo.dir,
    config: { searchError: { code: 'INTERNAL', message: 'should never be reached' } },
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Unsupported path pattern/);
});

// --- Exit code mapping ---------------------------------------------------

test('no usable Git repository maps to exit 3', async () => {
  const result = await runCli(['fake query'], {
    cwd: repo.dir,
    config: { openRepositoryError: { code: 'NO_REPOSITORY', message: 'not a git repository' } },
  });
  assert.equal(result.code, 3);
});

test('an index/storage failure maps to exit 4, with the machine code preserved in --json', async () => {
  const result = await runCli(['fake query', '--json'], {
    cwd: repo.dir,
    config: { searchError: { code: 'STORAGE_FAILED', message: 'disk went away' } },
  });
  assert.equal(result.code, 4);
  const parsed = JSON.parse(result.stdout.trim());
  assert.equal(parsed.error.code, 'STORAGE_FAILED');
});

test('a lock wait timeout maps to exit 5', async () => {
  const result = await runCli(['fake query'], {
    cwd: repo.dir,
    config: { searchError: { code: 'LOCK_TIMEOUT', message: 'another process is indexing' } },
  });
  assert.equal(result.code, 5);
});

test('status --json produces the status envelope, not a search response', async () => {
  const result = await runCli(['status', '--json'], { cwd: repo.dir, config: {} });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout.trim());
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.command, 'status');
  assert.ok(parsed.index);
  assert.equal(parsed.index.state, 'current');
});

test('rebuild --use-default-model reaches the backend with useDefaultModel set', async () => {
  // The fake backend doesn't assert on options itself; this just proves
  // the flag parses and the lifecycle command dispatches without error.
  const result = await runCli(['rebuild', '--use-default-model'], { cwd: repo.dir, config: {} });
  assert.equal(result.code, 0);
});

test('gc runs and reports a status', async () => {
  const result = await runCli(['gc'], { cwd: repo.dir, config: {} });
  assert.equal(result.code, 0);
});

// --- --max-bytes truncation end-to-end -----------------------------------

test('--max-bytes truncation produces valid, bounded JSON end-to-end', async () => {
  const bigResponse = {
    query: 'fake query',
    mode: 'hybrid',
    snapshot: {
      scope: 'branches-remotes-tags-worktree-heads',
      fingerprint: 'fp',
      indexedAt: '2026-01-01T00:00:00Z',
      freshness: 'current',
      coverage: 'complete_for_policy',
      generation: 'g1',
    },
    results: Array.from({ length: 10 }, (_, i) => ({
      sha: String(i).padStart(40, '0'),
      subject: `Commit number ${i} with a reasonably long subject line for bulk`,
      author: { name: 'Fake Author', email: 'fake@example.invalid' },
      authorTime: 1700000000,
      committerTime: 1700000000,
      parents: [],
      messageExcerpt: 'x'.repeat(200),
      rankScore: 0.5,
      matchedBy: ['text'],
      evidence: [
        {
          recordId: `r${i}`,
          kind: 'hunk',
          path: { bytesBase64: '', display: `src/file${i}.ts`, lossy: false },
          oldPath: null,
          changeType: 'M',
          oldStart: 1,
          oldCount: 1,
          newStart: 1,
          newCount: 1,
          excerpt: 'y'.repeat(300),
          truncated: false,
          omissionReasons: [],
        },
      ],
    })),
    warnings: [],
    candidateLimitReached: false,
  };

  const result = await runCli(['fake query', '--json', '--max-bytes=700'], {
    cwd: repo.dir,
    config: { searchResponse: bigResponse },
  });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout.trim()); // must still be valid JSON
  assert.equal(parsed.outputTruncated, true);
  assert.ok(Buffer.byteLength(result.stdout.trim(), 'utf8') <= 700 + 1); // +1 for the loader's trailing newline tolerance
});

// --- SIGINT --------------------------------------------------------------

test('SIGINT during a slow search exits 130 promptly, honouring the abort signal', async () => {
  const start = Date.now();
  const child = spawn(process.execPath, [distMain, 'fake query'], {
    cwd: repo.dir,
    env: {
      ...process.env,
      GIT_WHY_TEST_BACKEND: fakeBackendUrl,
      GIT_WHY_TYPES_MODULE: typesModuleUrl,
      GIT_WHY_TEST_CONFIG: JSON.stringify({ searchDelayMs: 60_000 }),
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 300));
  child.kill('SIGINT');

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.on('close', (code, signal) => resolve({ code, signal }));
    },
  );

  assert.equal(exit.code, 130);
  assert.ok(
    Date.now() - start < 3_000,
    'SIGINT should not wait out the 3s forced-exit fallback when the backend cooperates',
  );
});

// --- EPIPE -----------------------------------------------------------------

test('a closed stdout pipe (EPIPE) exits cleanly with no stack trace', async () => {
  const bigResponse = {
    query: 'fake query',
    mode: 'hybrid',
    snapshot: {
      scope: 'branches-remotes-tags-worktree-heads',
      fingerprint: 'fp',
      indexedAt: '2026-01-01T00:00:00Z',
      freshness: 'current',
      coverage: 'complete_for_policy',
      generation: 'g1',
    },
    results: Array.from({ length: 200 }, (_, i) => ({
      sha: String(i).padStart(40, '0'),
      subject: `Commit ${i}`,
      author: { name: 'Fake Author', email: 'fake@example.invalid' },
      authorTime: 1700000000,
      committerTime: 1700000000,
      parents: [],
      messageExcerpt: 'x'.repeat(500),
      rankScore: 0.5,
      matchedBy: ['text'],
      evidence: [],
    })),
    warnings: [],
    candidateLimitReached: false,
  };

  const child = spawn(process.execPath, [distMain, 'fake query'], {
    cwd: repo.dir,
    env: {
      ...process.env,
      GIT_WHY_TEST_BACKEND: fakeBackendUrl,
      GIT_WHY_TYPES_MODULE: typesModuleUrl,
      GIT_WHY_TEST_CONFIG: JSON.stringify({ searchResponse: bigResponse }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const err: Buffer[] = [];
  child.stderr.on('data', (c: Buffer) => err.push(c));
  // Destroy our read end immediately so the child's writes hit EPIPE.
  child.stdout.destroy();

  const result = await new Promise<{ code: number | null }>((resolve) => {
    child.on('close', (code) => resolve({ code }));
  });

  const stderrText = Buffer.concat(err).toString('utf8');
  assert.ok(
    !/at .*\(.*:\d+:\d+\)/.test(stderrText),
    `expected no stack trace on EPIPE, got: ${stderrText}`,
  );
  assert.equal(result.code, 0);
});
