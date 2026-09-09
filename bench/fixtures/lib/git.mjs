// Minimal git process wrapper for fixture construction. Deliberately
// separate from anything in src/git/ -- bench code must never import product
// internals, and product internals must never import bench code.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const FIXED_TZ_OFFSET = '+0000';

export function git(cwd, args, extraEnv = {}) {
  const res = spawnSync('git', args, {
    cwd,
    shell: false,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', TZ: 'UTC', ...extraEnv },
  });
  if (res.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed in ${cwd}:\n${res.stdout ?? ''}\n${res.stderr ?? ''}`,
    );
  }
  return (res.stdout ?? '').trim();
}

/** Fresh, deterministic repository. Removes any prior contents at `dir`. */
export function initRepo(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '--quiet', '--initial-branch=main']);
  git(dir, ['config', 'user.name', 'Fixture Bot']);
  git(dir, ['config', 'user.email', 'fixture-bot@git-why.bench']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'tag.gpgsign', 'false']);
  return dir;
}

export function writeRepoFile(dir, relPath, content) {
  const abs = `${dir}/${relPath}`;
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

export function removeRepoFile(dir, relPath) {
  const abs = `${dir}/${relPath}`;
  if (existsSync(abs)) rmSync(abs);
}

export function renameRepoFile(dir, fromRel, toRel) {
  const content = readFileSync(`${dir}/${fromRel}`, 'utf8');
  removeRepoFile(dir, fromRel);
  writeRepoFile(dir, toRel, content);
}

/**
 * Deterministic commit. `epochSeconds` and identity are pinned so the
 * resulting commit SHA is reproducible across machines and runs, given
 * identical tree contents and history so far. This is the property the
 * dataset relies on: labeled SHAs stay stable without committing the
 * generated repository itself.
 */
export function commitAll(
  dir,
  { message, epochSeconds, authorName, authorEmail, allowEmpty = false },
) {
  git(dir, ['add', '-A']);
  const dateStr = `${epochSeconds} ${FIXED_TZ_OFFSET}`;
  const env = {
    GIT_AUTHOR_NAME: authorName ?? 'Fixture Bot',
    GIT_AUTHOR_EMAIL: authorEmail ?? 'fixture-bot@git-why.bench',
    GIT_AUTHOR_DATE: dateStr,
    GIT_COMMITTER_NAME: authorName ?? 'Fixture Bot',
    GIT_COMMITTER_EMAIL: authorEmail ?? 'fixture-bot@git-why.bench',
    GIT_COMMITTER_DATE: dateStr,
  };
  const args = ['commit', '--quiet', '-m', message];
  if (allowEmpty) args.push('--allow-empty');
  git(dir, args, env);
  return git(dir, ['rev-parse', 'HEAD']);
}

export function currentHead(dir) {
  return git(dir, ['rev-parse', 'HEAD']);
}

export function treeHash(dir) {
  return git(dir, ['rev-parse', 'HEAD^{tree}']);
}

export function objectCount(dir) {
  const out = git(dir, ['count-objects', '-v']);
  const m = /count: (\d+)/.exec(out);
  return m ? Number(m[1]) : null;
}

export function revList(dir) {
  return git(dir, ['rev-list', '--all']).split('\n').filter(Boolean);
}
