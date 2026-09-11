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
 *   - The man page ships in the tarball at the path `install.sh` expects
 *     (`<npm root -g>/@alliecatowo/git-why/man/git-why.1`) and, once copied
 *     into place the same way `install.sh` copies it, `git why --help` —
 *     which Git itself intercepts and redirects to `man git-why` — resolves
 *     through it. npm's own "man" package.json field is NOT relied on here:
 *     bin-links@7 (npm >= 7) stopped linking man pages for any package
 *     (see bin-links/lib/index.js's own comment to that effect), which is
 *     exactly why `install.sh` copies the file manually instead.
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
  'man',
  // The Claude Code plugin: manifest, MCP registration, skill and agent.
  // Shipped with the CLI so installing the tool installs the integration.
  'plugin',
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

    // `git <cmd> --help` as the literal first argument is intercepted by Git
    // itself (git.c rewrites it to `git help <cmd> --exclude-guides`, which
    // looks for a `git-<cmd>` man page) for ANY subcommand, built-in or
    // external — verified with GIT_TRACE=1 against a throwaway `git-foo`
    // script. Git does not execute the external command in that case. `-h`,
    // or `--help` in a non-first position, is passed through regardless, so
    // that is checked too, but the real fix is the man page.
    console.log('verify-package: git why -h (via PATH discovery)...');
    const viaGitHelp = spawnSync('git', ['why', '-h'], { cwd: elsewhere, env, encoding: 'utf8' });
    if (viaGitHelp.status !== 0 || !viaGitHelp.stdout.includes('Usage: git why')) {
      fail(`git why -h failed: status=${viaGitHelp.status} stderr=${viaGitHelp.stderr}`);
    }

    // Confirmed empirically against the npm actually on PATH in this repo's
    // toolchain (npm 12.0.2, bundling bin-links@7.0.0): `npm install
    // --global` does NOT link package.json's "man" field anywhere anymore;
    // bin-links@7's link-mans step was removed outright. So this checks the
    // real contract instead: the man page ships inside the installed
    // package at the path `install.sh` reads it from, and copying it the
    // same way `install.sh` does makes `git why --help` resolve through
    // Git's own man dispatch.
    console.log('verify-package: man page ships at the path install.sh expects...');
    const npmRoot = run('npm', ['root', '--global', '--prefix', prefix], { cwd: work }).trim();
    const manSrc = path.join(npmRoot, '@alliecatowo', 'git-why', 'man', 'git-why.1');
    if (!existsSync(manSrc)) {
      fail(`expected the installed package to ship a man page at ${manSrc}`);
    } else {
      const manDir = path.join(prefix, 'share', 'man');
      const man1Dir = path.join(manDir, 'man1');
      const manDestination = path.join(man1Dir, 'git-why.1');
      execFileSync('mkdir', ['-p', man1Dir]);
      // Some npm versions already link package.json's `man` entry. Do not
      // turn that successful state into a verifier failure by copying a file
      // onto itself; install.sh's copy is only needed when no link exists.
      if (!existsSync(manDestination)) execFileSync('cp', [manSrc, manDestination]);
      console.log('verify-package: git why --help (via PATH+MANPATH, through Git dispatch)...');
      const envWithMan = { ...env, MANPATH: manDir };
      const viaGitFullHelp = spawnSync('git', ['why', '--help'], {
        cwd: elsewhere,
        env: envWithMan,
        encoding: 'utf8',
      });
      if (viaGitFullHelp.status !== 0 || !viaGitFullHelp.stdout.includes('git-why')) {
        fail(
          `git why --help (through Git's man dispatch) failed: status=${viaGitFullHelp.status} ` +
            `stdout=${viaGitFullHelp.stdout} stderr=${viaGitFullHelp.stderr}`,
        );
      }
    }

    if (process.exitCode !== 1) {
      console.log('\nverify-package: all checks passed.');
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main();
