/**
 * The only module in this project that spawns Git.
 *
 * Every invocation goes through `runGit`, which:
 *  - never composes a shell string (argv arrays, `shell: false`),
 *  - disables interactive prompts, external diff/textconv, paging and color,
 *  - neutralises global/system config and attribute overrides so the same
 *    commit extracts identically regardless of the caller's environment,
 *  - disables replace-object interpretation and (when the installed Git
 *    supports it) lazy fetching of partial-clone objects,
 *  - streams stdout/stderr with a hard byte cap instead of buffering an
 *    unbounded string before checking size.
 *
 * Capability flags are probed against the real installed `git` binary once
 * per process and cached; nothing here assumes a feature exists because a
 * version number looks new enough (see docs/spec.md #6, #7, #29).
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitWhyError } from '../types.js';

/** Real, probed capabilities of the installed `git` binary. Never assumed from a version string. */
export interface GitCapabilities {
  readonly version: string;
  /** `--no-replace-objects` global flag. */
  readonly noReplaceObjects: boolean;
  /** `--no-lazy-fetch` global flag (prevents partial-clone promisor fetches). */
  readonly noLazyFetch: boolean;
  /** `--no-optional-locks` global flag. */
  readonly noOptionalLocks: boolean;
  /** `--no-advice` global flag. */
  readonly noAdvice: boolean;
  /** `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` env overrides (Git >= 2.32). */
  readonly configPathOverride: boolean;
  /**
   * `--attr-source=<treeish>` on `diff`/`log`/`show` (Git >= 2.40), which would let us
   * resolve `.gitattributes` from the historical commit instead of the worktree.
   * Probed and typically false on this machine's Apple Git build; when false we fall
   * back to running attribute-sensitive plumbing with `cwd` outside any worktree and an
   * explicit `--git-dir`, which this repository's probing showed avoids worktree
   * `.gitattributes` entirely for `diff-tree` (no worktree is ever consulted). Recorded
   * here purely so the extraction-config fingerprint changes if a future Git adds it.
   */
  readonly attrSource: boolean;
}

let cached: Promise<GitCapabilities> | undefined;

/** Probe real Git capabilities once per process. Never assume a flag exists from a version string. */
export function probeGitCapabilities(): Promise<GitCapabilities> {
  cached ??= probeNow();
  return cached;
}

async function probeNow(): Promise<GitCapabilities> {
  const versionResult = await spawnRaw(['git', 'version'], { cwd: tmpdir(), env: minimalEnv(), maxBytes: 4096 });
  const version = versionResult.stdout.toString('utf8').trim();

  const [noReplaceObjects, noLazyFetch, noOptionalLocks, noAdvice] = await Promise.all([
    probeGlobalFlag('--no-replace-objects'),
    probeGlobalFlag('--no-lazy-fetch'),
    probeGlobalFlag('--no-optional-locks'),
    probeGlobalFlag('--no-advice'),
  ]);
  const configPathOverride = await probeConfigPathOverride();
  const attrSource = await probeAttrSource();

  return {
    version,
    noReplaceObjects,
    noLazyFetch,
    noOptionalLocks,
    noAdvice,
    configPathOverride,
    attrSource,
  };
}

async function probeGlobalFlag(flag: string): Promise<boolean> {
  // A real global flag is listed in git's own usage error for a deliberately unknown
  // flag, and does not itself produce "unknown option" when used with --version.
  const result = await spawnRaw(['git', flag, '--version'], { cwd: tmpdir(), env: minimalEnv(), maxBytes: 4096 });
  if (result.code !== 0) return false;
  return !/unknown option/i.test(result.stderr.toString('utf8'));
}

async function probeConfigPathOverride(): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), 'gitwhy-probe-'));
  try {
    const sentinel = join(dir, 'sentinel-gitconfig');
    await writeFile(sentinel, '[user]\n\tname = git-why-probe-sentinel\n');
    const result = await spawnRaw(['git', 'config', '--get', 'user.name'], {
      cwd: dir,
      env: { ...minimalEnv(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      maxBytes: 4096,
    });
    // With the override in place and no local config, the sentinel must NOT appear.
    return result.code !== 0 || !result.stdout.toString('utf8').includes('git-why-probe-sentinel');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function probeAttrSource(): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), 'gitwhy-probe-'));
  try {
    await spawnRaw(['git', 'init', '-q'], { cwd: dir, env: minimalEnv(), maxBytes: 4096 });
    await spawnRaw(['git', 'config', 'user.name', 'probe'], { cwd: dir, env: minimalEnv(), maxBytes: 4096 });
    await spawnRaw(['git', 'config', 'user.email', 'probe@example.com'], { cwd: dir, env: minimalEnv(), maxBytes: 4096 });
    await writeFile(join(dir, 'f.txt'), 'x\n');
    await spawnRaw(['git', 'add', 'f.txt'], { cwd: dir, env: minimalEnv(), maxBytes: 4096 });
    await spawnRaw(['git', 'commit', '-q', '-m', 'probe'], { cwd: dir, env: minimalEnv(), maxBytes: 4096 });
    const head = await spawnRaw(['git', 'rev-parse', 'HEAD'], { cwd: dir, env: minimalEnv(), maxBytes: 4096 });
    const sha = head.stdout.toString('utf8').trim();
    const result = await spawnRaw(['git', 'show', `--attr-source=${sha}`, sha], {
      cwd: dir,
      env: minimalEnv(),
      maxBytes: 4096,
    });
    return result.code === 0;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function minimalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // Keep only what a child process needs to locate the git binary and behave predictably.
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'SYSTEMROOT', 'SystemRoot']) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  return env;
}

/** Bound stdout/stderr accumulation; a pathological commit must not become a giant string. */
export interface CapResult {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly truncatedStdout: boolean;
  readonly truncatedStderr: boolean;
}

interface SpawnOpts {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly maxBytes: number;
  readonly input?: Buffer;
}

function spawnRaw(argv: readonly string[], opts: SpawnOpts): Promise<CapResult> {
  return new Promise((resolve, reject) => {
    const first = argv[0];
    if (first === undefined) {
      reject(new GitWhyError('INTERNAL', 'spawnRaw called with an empty argv'));
      return;
    }
    const child = spawn(first, argv.slice(1), {
      cwd: opts.cwd,
      env: opts.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const out = new CappedSink(opts.maxBytes, () => child.kill('SIGTERM'));
    const err = new CappedSink(opts.maxBytes, () => child.kill('SIGTERM'));
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));

    child.on('error', (error) => reject(error));
    child.on('close', (code, signal) => {
      resolve({
        stdout: out.buffer(),
        stderr: err.buffer(),
        code,
        signal,
        truncatedStdout: out.truncated,
        truncatedStderr: err.truncated,
      });
    });

    if (opts.input !== undefined) {
      child.stdin.end(opts.input);
    } else {
      child.stdin.end();
    }
  });
}

/** Accumulates chunks up to a byte cap, then stops copying and signals the caller to stop the source. */
class CappedSink {
  private chunks: Buffer[] = [];
  private total = 0;
  truncated = false;

  constructor(
    private readonly cap: number,
    private readonly onExceeded: () => void,
  ) {}

  push(chunk: Buffer): void {
    if (this.truncated) return;
    const remaining = this.cap - this.total;
    if (remaining <= 0) {
      this.truncated = true;
      this.onExceeded();
      return;
    }
    if (chunk.length > remaining) {
      this.chunks.push(chunk.subarray(0, remaining));
      this.total = this.cap;
      this.truncated = true;
      this.onExceeded();
      return;
    }
    this.chunks.push(chunk);
    this.total += chunk.length;
  }

  buffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/** Global options applied to EVERY invocation, gated on real probed capabilities. */
function globalArgs(gitDir: string, caps: GitCapabilities): string[] {
  const args: string[] = ['--git-dir', gitDir];
  if (caps.noReplaceObjects) args.push('--no-replace-objects');
  if (caps.noLazyFetch) args.push('--no-lazy-fetch');
  if (caps.noOptionalLocks) args.push('--no-optional-locks');
  if (caps.noAdvice) args.push('--no-advice');
  // Belt-and-suspenders beyond env vars: -c wins over any config source, including ones
  // a caller's environment might otherwise inject via GIT_CONFIG_COUNT/GIT_CONFIG_KEY_*.
  args.push('-c', 'core.pager=cat');
  args.push('-c', 'color.ui=false');
  args.push('-c', 'color.diff=false');
  args.push('-c', 'diff.external=');
  args.push('-c', 'interactive.diffFilter=');
  args.push('-c', 'credential.helper=');
  args.push('-c', 'core.askPass=true');
  args.push('-c', 'gc.auto=0');
  args.push('-c', 'advice.detachedHead=false');
  return args;
}

/** Environment applied to every invocation. Global/system config and attributes are neutralised. */
function gitEnv(caps: GitCapabilities): NodeJS.ProcessEnv {
  const env = minimalEnv();
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_ASKPASS = 'true';
  env.GIT_PAGER = 'cat';
  env.PAGER = 'cat';
  env.GIT_ATTR_NOSYSTEM = '1';
  env.GIT_CONFIG_NOSYSTEM = '1';
  if (caps.configPathOverride) {
    env.GIT_CONFIG_GLOBAL = '/dev/null';
    env.GIT_CONFIG_SYSTEM = '/dev/null';
  }
  // Never inherit ambient GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE; we always pass --git-dir
  // explicitly and never a work tree, which also keeps plumbing independent of whatever
  // .gitattributes happens to be checked out in the caller's cwd.
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  return env;
}

export interface RunGitOptions {
  /** Absolute, canonical common directory. Always passed as `--git-dir`. */
  readonly gitDir: string;
  readonly args: readonly string[];
  /**
   * Working directory for the child process. Must be outside any worktree for
   * attribute-sensitive plumbing (diff-tree, diff, log -p); `gitDir` itself is a safe
   * default that also works for bare repositories and subdirectory invocation.
   */
  readonly cwd: string;
  readonly input?: Buffer;
  /** Hard cap on stdout/stderr bytes. Exceeding it truncates and kills the process. */
  readonly maxBytes?: number;
}

export interface RunGitResult extends CapResult {
  readonly argv: readonly string[];
}

const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

/** Run one Git invocation with every ingestion-safety option applied. */
export async function runGit(opts: RunGitOptions): Promise<RunGitResult> {
  const caps = await probeGitCapabilities();
  const argv = ['git', ...globalArgs(opts.gitDir, caps), ...opts.args];
  const result = await spawnRaw(argv, {
    cwd: opts.cwd,
    env: gitEnv(caps),
    maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES,
    input: opts.input,
  });
  return { ...result, argv };
}

/** Run Git and throw a `GitWhyError` on a non-zero exit (after the process has already ended). */
export async function runGitOrThrow(opts: RunGitOptions): Promise<RunGitResult> {
  const result = await runGit(opts);
  if (result.code !== 0) {
    throw new GitWhyError('EXTRACTION_FAILED', `git ${opts.args.join(' ')} failed: ${result.stderr.toString('utf8').trim()}`, {
      hint: `argv: ${result.argv.join(' ')}`,
    });
  }
  return result;
}

/**
 * A one-off invocation used only for repository discovery (finding the common directory
 * itself). This is the single place allowed to run with a caller-supplied cwd that may be
 * inside a worktree, since `rev-parse` path/format queries do not consult attributes.
 */
export async function runGitDiscovery(cwd: string, args: readonly string[]): Promise<RunGitResult> {
  const caps = await probeGitCapabilities();
  const argv = ['git', ...args];
  const result = await spawnRaw(argv, { cwd, env: gitEnv(caps), maxBytes: DEFAULT_MAX_BYTES });
  return { ...result, argv };
}
