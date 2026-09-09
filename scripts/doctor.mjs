#!/usr/bin/env node
/**
 * Verifies tools, native dependency loading, Git capabilities and optional
 * benchmark prerequisites. Prints a plain report and a machine-readable
 * JSON summary (with --json), and exits nonzero only when a REQUIRED
 * capability is unavailable — never for an optional benchmark tool.
 *
 * Do not let this script quietly "fix" anything. Its job is to report an
 * unavailable Git capability plainly rather than let the product silently
 * change semantics (e.g. by pretending FTS works when it does not).
 */

import { execFile } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const jsonMode = process.argv.includes('--json');

/** @type {Array<{name: string, required: boolean, status: 'pass'|'fail'|'not_installed', detail: string}>} */
const checks = [];

function record(name, required, status, detail) {
  checks.push({ name, required, status, detail });
}

async function run(cmd, args) {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 10_000 });
    return { ok: true, output: stdout.trim() };
  } catch (err) {
    return { ok: false, output: err instanceof Error ? err.message : String(err) };
  }
}

async function checkNode() {
  const pkgRaw = readFileSync(path.join(repoRoot, 'package.json'), 'utf8');
  const pkg = JSON.parse(pkgRaw);
  const required = pkg.engines?.node ?? '>=22.12.0';
  const actual = process.version;
  // Minimal semver-range check for the common ">=X.Y.Z" shape used here.
  const match = /^>=(\d+)\.(\d+)\.(\d+)/.exec(required);
  const [, rMajor, rMinor, rPatch] = match ?? [null, '0', '0', '0'];
  const [aMajor, aMinor, aPatch] = actual.replace(/^v/, '').split('.').map(Number);
  const ok =
    aMajor > Number(rMajor) ||
    (aMajor === Number(rMajor) && aMinor > Number(rMinor)) ||
    (aMajor === Number(rMajor) && aMinor === Number(rMinor) && aPatch >= Number(rPatch));
  record('node', true, ok ? 'pass' : 'fail', `${actual} (required ${required})`);
}

/**
 * Runs a Git subcommand with immediately-closed stdin and treats a clean
 * exit as proof the flag is accepted (each of these commands legitimately
 * exits 0 on an empty request). This is a real probe, not a version guess.
 */
function probeGitFlag(args) {
  try {
    execFileSync('git', args, {
      input: '',
      cwd: repoRoot,
      stdio: ['pipe', 'ignore', 'pipe'],
      timeout: 10_000,
    });
    return { ok: true };
  } catch (err) {
    const stderr = err && typeof err === 'object' && 'stderr' in err ? String(err.stderr) : '';
    return {
      ok: false,
      detail: (stderr || (err instanceof Error ? err.message : String(err))).split('\n')[0],
    };
  }
}

async function checkGit() {
  const version = await run('git', ['--version']);
  if (!version.ok) {
    record('git', true, 'fail', `git not found: ${version.output}`);
    return;
  }
  record('git', true, 'pass', version.output);

  // Capabilities the extractor depends on, probed for real with empty
  // stdin rather than guessed from a version string.
  for (const [name, args] of [
    ['git rev-list --stdin', ['rev-list', '--stdin']],
    ['git diff-tree --stdin', ['diff-tree', '--stdin']],
    ['git cat-file --batch', ['cat-file', '--batch']],
    ['git cat-file --batch-check', ['cat-file', '--batch-check']],
  ]) {
    const result = probeGitFlag(args);
    record(name, true, result.ok ? 'pass' : 'fail', result.ok ? 'accepted' : result.detail);
  }
}

async function checkZvec() {
  try {
    const mod = await import('@zvec/zvec');
    const exportNames = Object.keys(mod);
    if (exportNames.length === 0) {
      record('@zvec/zvec native load', true, 'fail', 'module loaded but exported nothing');
      return;
    }
    record(
      '@zvec/zvec native load',
      true,
      'pass',
      `loaded, exports: ${exportNames.slice(0, 8).join(', ')}`,
    );
  } catch (err) {
    record(
      '@zvec/zvec native load',
      true,
      'fail',
      err instanceof Error ? err.message : String(err),
    );
  }
}

function checkModelCache() {
  const candidates = [
    process.env.GIT_WHY_MODEL_CACHE,
    path.join(os.homedir(), '.cache', 'git-why', 'models'),
    path.join(os.homedir(), 'Library', 'Caches', 'git-why', 'models'),
  ].filter(Boolean);
  const found = candidates.find((p) => p && existsSync(p));
  record(
    'model cache',
    false,
    found ? 'pass' : 'not_installed',
    found
      ? `present at ${found}`
      : 'not present yet (expected before first run; the CLI downloads it on demand)',
  );
}

async function checkOptionalTool(name, args = ['--version']) {
  const result = await run(name, args);
  record(
    name,
    false,
    result.ok ? 'pass' : 'not_installed',
    result.ok ? result.output.split('\n')[0] : 'not found on PATH',
  );
}

async function main() {
  await checkNode();
  await checkGit();
  await checkZvec();
  checkModelCache();
  // Benchmark-only prerequisites. Never attempt to install these.
  await checkOptionalTool('opencode');
  await checkOptionalTool('zg');

  const requiredFailures = checks.filter((c) => c.required && c.status === 'fail');

  if (jsonMode) {
    console.log(
      JSON.stringify(
        { platform: `${os.platform()}-${os.arch()}`, checks, ok: requiredFailures.length === 0 },
        null,
        2,
      ),
    );
  } else {
    console.log(`Git Why doctor — ${os.platform()}-${os.arch()}`);
    for (const c of checks) {
      const label =
        c.status === 'pass' ? 'PASS' : c.status === 'not_installed' ? 'NOT INSTALLED' : 'FAIL';
      const marker = c.required ? '' : ' (optional)';
      console.log(`  [${label}] ${c.name}${marker} — ${c.detail}`);
    }
    if (requiredFailures.length > 0) {
      console.log(`\n${requiredFailures.length} required check(s) failed.`);
    } else {
      console.log('\nAll required checks passed.');
    }
  }

  process.exit(requiredFailures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('doctor: unexpected failure:', err);
  process.exit(1);
});
