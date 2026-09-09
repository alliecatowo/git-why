#!/usr/bin/env node
/**
 * Packs the project, installs the tarball into a temporary npm prefix, and
 * verifies:
 *
 *   - `git-why --version` and `--help` work with NO model and NO index.
 *   - The binary is discoverable as `git why` from a DIFFERENT directory,
 *     by putting the temp prefix's bin directory on PATH (this is how Git
 *     finds `git-<subcommand>` executables for real).
 *   - The tarball excludes credentials, test repositories, transcripts,
 *     benchmark caches, indexes, model weights and development worktrees.
 *   - The shebang and executable file mode survive packing.
 *
 * Everything happens under a temporary directory; nothing here touches the
 * project's own `node_modules` or lockfile.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const FORBIDDEN_PATH_PATTERNS = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)credentials(\.|\/|$)/i,
  /(^|\/)auth\.json$/i,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)test\//,
  /(^|\/)bench\//,
  /(^|\/)spike\//,
  /(^|\/)\.worktrees?\//,
  /\.zvec($|\/)/i,
  /\.onnx$/i,
  /\.safetensors$/i,
  /\.gguf$/i,
];

const ALLOWED_TOP_LEVEL = new Set([
  'package.json',
  'README.md',
  'LICENSE',
  'NOTICE',
  'dist',
  'schema',
]);

function fail(message) {
  console.error(`verify-package: FAIL — ${message}`);
  process.exitCode = 1;
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`${cmd} ${args.join(' ')} exited ${result.status}\n${detail}`);
  }
  return result.stdout;
}

function main() {
  if (!existsSync(path.join(repoRoot, 'dist', 'cli', 'main.js'))) {
    console.log('verify-package: dist/ missing, building first...');
    run('npm', ['run', 'build'], { cwd: repoRoot });
  }

  const work = mkdtempSync(path.join(os.tmpdir(), 'git-why-verify-'));
  const prefix = path.join(work, 'prefix');
  const elsewhere = path.join(work, 'elsewhere');
  execFileSync('mkdir', ['-p', prefix, elsewhere]);

  try {
    console.log('verify-package: npm pack...');
    const packOutput = run('npm', ['pack', '--json', '--pack-destination', work], {
      cwd: repoRoot,
    });
    const parsedPackOutput = JSON.parse(packOutput);
    // Different npm versions have shipped `npm pack --json` as either a
    // top-level array of pack results, or an object keyed by package name.
    const packInfo = Array.isArray(parsedPackOutput)
      ? parsedPackOutput[0]
      : Object.values(parsedPackOutput)[0];
    if (!packInfo) throw new Error(`could not parse npm pack --json output:\n${packOutput}`);
    const tarballPath = path.join(work, packInfo.filename);
    if (!existsSync(tarballPath)) throw new Error(`expected tarball at ${tarballPath}`);
    console.log(
      `verify-package: tarball at ${tarballPath} (${packInfo.size} bytes packed, ${packInfo.unpackedSize} unpacked)`,
    );

    console.log('verify-package: inspecting tarball contents...');
    const listing = run('tar', ['-tzf', tarballPath])
      .split('\n')
      .filter(Boolean)
      .map((entry) => entry.replace(/^package\//, ''))
      .filter((entry) => entry.length > 0);

    for (const entry of listing) {
      for (const pattern of FORBIDDEN_PATH_PATTERNS) {
        if (pattern.test(entry)) {
          fail(`tarball contains forbidden path "${entry}" (matched ${pattern})`);
        }
      }
      const top = entry.split('/')[0];
      if (!ALLOWED_TOP_LEVEL.has(top)) {
        fail(`tarball contains unexpected top-level entry "${entry}"`);
      }
    }
    if (!listing.some((e) => e === 'dist/cli/main.js')) {
      fail('tarball is missing dist/cli/main.js');
    }
    console.log(`verify-package: ${listing.length} entries, none forbidden.`);

    console.log('verify-package: extracting to check shebang and mode survive packing...');
    const extractDir = path.join(work, 'extracted');
    execFileSync('mkdir', ['-p', extractDir]);
    run('tar', ['-xzf', tarballPath, '-C', extractDir]);
    const extractedMain = path.join(extractDir, 'package', 'dist', 'cli', 'main.js');
    const firstLine = readFileSync(extractedMain, 'utf8').split('\n')[0];
    if (firstLine !== '#!/usr/bin/env node') {
      fail(
        `extracted dist/cli/main.js lost its shebang (first line: ${JSON.stringify(firstLine)})`,
      );
    }
    const mode = statSync(extractedMain).mode & 0o777;
    if ((mode & 0o111) === 0) {
      fail(`extracted dist/cli/main.js is not executable (mode ${mode.toString(8)})`);
    } else {
      console.log(
        `verify-package: shebang and executable mode (${mode.toString(8)}) survived packing.`,
      );
    }

    console.log('verify-package: installing tarball into a temporary prefix...');
    run(
      'npm',
      ['install', '--global', '--prefix', prefix, '--no-audit', '--fund=false', tarballPath],
      { cwd: work },
    );

    const binDir = path.join(prefix, 'bin');
    if (!existsSync(path.join(binDir, 'git-why'))) {
      fail(`expected ${binDir}/git-why to exist after install`);
    }

    const env = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}`, NO_COLOR: '1' };
    // Make sure no ambient model cache or index leaks into this check.
    delete env.GIT_WHY_MODEL_CACHE;

    console.log('verify-package: git-why --version (direct)...');
    const directVersion = spawnSync('git-why', ['--version'], {
      cwd: elsewhere,
      env,
      encoding: 'utf8',
    });
    if (directVersion.status !== 0 || !directVersion.stdout.trim()) {
      fail(
        `git-why --version failed: status=${directVersion.status} stderr=${directVersion.stderr}`,
      );
    } else {
      console.log(`verify-package: git-why --version -> ${directVersion.stdout.trim()}`);
    }

    console.log('verify-package: git-why --help (direct, no model, no index)...');
    const directHelp = spawnSync('git-why', ['--help'], { cwd: elsewhere, env, encoding: 'utf8' });
    if (directHelp.status !== 0 || !directHelp.stdout.includes('Usage: git why')) {
      fail(`git-why --help failed: status=${directHelp.status} stderr=${directHelp.stderr}`);
    }

    console.log(
      'verify-package: git why --version (via PATH discovery, from a different directory)...',
    );
    const viaGit = spawnSync('git', ['why', '--version'], {
      cwd: elsewhere,
      env,
      encoding: 'utf8',
    });
    if (viaGit.status !== 0 || !viaGit.stdout.trim()) {
      fail(`git why --version failed: status=${viaGit.status} stderr=${viaGit.stderr}`);
    } else {
      console.log(`verify-package: git why --version -> ${viaGit.stdout.trim()}`);
    }

    // NOTE: `git <cmd> --help` as the literal first argument is intercepted
    // by Git itself (git.c redirects to `git help <cmd>`, looking for a man
    // page) for ANY subcommand, built-in or external — verified with
    // GIT_TRACE=1 against a throwaway `git-foo` script. Git does not
    // execute the external command in that case, regardless of what it
    // does. Only `-h`, or `--help` in a non-first position, is passed
    // through. Shipping a man page to satisfy `git why --help` is out of
    // scope for V1 packaging, so this check uses `-h`, which Git always
    // forwards, plus a direct `git-why --help` check above that does not
    // go through Git's dispatch at all.
    console.log('verify-package: git why -h (via PATH discovery)...');
    const viaGitHelp = spawnSync('git', ['why', '-h'], { cwd: elsewhere, env, encoding: 'utf8' });
    if (viaGitHelp.status !== 0 || !viaGitHelp.stdout.includes('Usage: git why')) {
      fail(`git why -h failed: status=${viaGitHelp.status} stderr=${viaGitHelp.stderr}`);
    }

    if (process.exitCode !== 1) {
      console.log('\nverify-package: all checks passed.');
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main();
