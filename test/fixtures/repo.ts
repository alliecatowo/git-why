/**
 * Test-only helper that builds real Git repositories by driving real `git` commands.
 * Never hand-writes object files. Author/committer identity and timestamps are fixed
 * so extraction is reproducible across runs and machines.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile as fsWriteFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}

function run(
  cwd: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
  input?: Buffer,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args as string[], {
      cwd,
      shell: false,
      env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        code,
      });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

let counter = 0;
/** Deterministic, monotonically increasing commit timestamps: reproducible, ordered history. */
function nextTimestamp(): string {
  counter += 1;
  const base = 1700000000; // fixed epoch base, unrelated to wall-clock test run time
  return `${base + counter * 60} +0000`;
}

export const FIXTURE_AUTHOR_NAME = 'Git Why Fixture';
export const FIXTURE_AUTHOR_EMAIL = 'fixture@git-why.test';

export interface TestRepo {
  readonly dir: string;
  git(
    args: readonly string[],
    opts?: { input?: Buffer; env?: NodeJS.ProcessEnv },
  ): Promise<RunResult>;
  gitOrThrow(
    args: readonly string[],
    opts?: { input?: Buffer; env?: NodeJS.ProcessEnv },
  ): Promise<RunResult>;
  /** Write a file. `name` may be a Buffer for byte-exact, possibly non-UTF-8, filenames. */
  writeFile(name: string | Buffer, content: string | Buffer): Promise<void>;
  add(paths: readonly (string | Buffer)[]): Promise<void>;
  rm(paths: readonly (string | Buffer)[]): Promise<void>;
  mv(from: string | Buffer, to: string | Buffer): Promise<void>;
  /** Commit staged changes with a fixed, deterministic author/committer identity and clock. */
  commit(message: string): Promise<string>;
  /** `HEAD` after the most recent commit. */
  head(): Promise<string>;
  currentBranch(): Promise<string>;
  cleanup(): Promise<void>;
}

export interface CreateTestRepoOptions {
  readonly objectFormat?: 'sha1' | 'sha256';
  readonly bare?: boolean;
}

/**
 * Probe whether the installed Git actually supports `--object-format=sha256`. Some
 * builds accept the flag but the resulting repository is unusable; callers should
 * skip the SHA-256 test with a clear message when this returns false, per the
 * required acceptance matrix (spec #29).
 */
export async function supportsObjectFormat(format: 'sha1' | 'sha256'): Promise<boolean> {
  if (format === 'sha1') return true;
  const dir = await mkdtemp(join(tmpdir(), 'gitwhy-probe-fmt-'));
  try {
    const init = await run(dir, ['init', '-q', '--object-format=sha256']);
    if (init.code !== 0) return false;
    const check = await run(dir, ['rev-parse', '--show-object-format=storage']);
    return check.code === 0 && check.stdout.trim() === 'sha256';
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function createTestRepo(options: CreateTestRepoOptions = {}): Promise<TestRepo> {
  const dir = await mkdtemp(join(tmpdir(), 'gitwhy-fixture-'));
  const initArgs = ['init', '-q'];
  if (options.objectFormat === 'sha256') initArgs.push('--object-format=sha256');
  if (options.bare === true) initArgs.push('--bare');
  const initResult = await run(dir, initArgs);
  if (initResult.code !== 0) {
    throw new Error(`git init failed: ${initResult.stderr}`);
  }
  await run(dir, ['config', 'user.name', FIXTURE_AUTHOR_NAME]);
  await run(dir, ['config', 'user.email', FIXTURE_AUTHOR_EMAIL]);
  await run(dir, ['config', 'commit.gpgsign', 'false']);
  await run(dir, ['config', 'tag.gpgsign', 'false']);
  await run(dir, ['branch', '-m', 'main']);

  const repo: TestRepo = {
    dir,
    async git(args, opts) {
      return run(dir, args, opts?.env, opts?.input);
    },
    async gitOrThrow(args, opts) {
      const result = await run(dir, args, opts?.env, opts?.input);
      if (result.code !== 0) {
        throw new Error(`git ${args.join(' ')} failed (${result.code}): ${result.stderr}`);
      }
      return result;
    },
    async writeFile(name, content) {
      const rel = typeof name === 'string' ? Buffer.from(name, 'utf8') : name;
      const full = Buffer.concat([Buffer.from(dir + '/', 'utf8'), rel]);
      if (typeof name === 'string' && name.includes('/')) {
        await mkdir(join(dir, dirname(name)), { recursive: true }).catch(() => {});
      }
      const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
      await fsWriteFile(full, data);
    },
    async add(paths) {
      const args = ['add', '--'];
      for (const p of paths) args.push(typeof p === 'string' ? p : p.toString('utf8'));
      await repo.gitOrThrow(args);
    },
    async rm(paths) {
      const args = ['rm', '-q', '--'];
      for (const p of paths) args.push(typeof p === 'string' ? p : p.toString('utf8'));
      await repo.gitOrThrow(args);
    },
    async mv(from, to) {
      const a = typeof from === 'string' ? from : from.toString('utf8');
      const b = typeof to === 'string' ? to : to.toString('utf8');
      await repo.gitOrThrow(['mv', a, b]);
    },
    async commit(message) {
      const ts = nextTimestamp();
      const env: NodeJS.ProcessEnv = {
        GIT_AUTHOR_NAME: FIXTURE_AUTHOR_NAME,
        GIT_AUTHOR_EMAIL: FIXTURE_AUTHOR_EMAIL,
        GIT_AUTHOR_DATE: ts,
        GIT_COMMITTER_NAME: FIXTURE_AUTHOR_NAME,
        GIT_COMMITTER_EMAIL: FIXTURE_AUTHOR_EMAIL,
        GIT_COMMITTER_DATE: ts,
      };
      const result = await run(dir, ['commit', '-q', '-m', message], env);
      if (result.code !== 0) {
        throw new Error(`git commit failed: ${result.stderr}`);
      }
      return repo.head();
    },
    async head() {
      const result = await repo.gitOrThrow(['rev-parse', 'HEAD']);
      return result.stdout.trim();
    },
    async currentBranch() {
      const result = await repo.gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD']);
      return result.stdout.trim();
    },
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
  return repo;
}
