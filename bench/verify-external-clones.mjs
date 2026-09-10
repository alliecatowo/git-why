// Verifies every external-v2 clone exposes EXACTLY its pinned history.
//
// This exists because the clones silently drifted. Each was created correctly
// as a single ref at its cutoff, but something later re-fetched branches and
// tags, and `git why index`'s default scope is branches+remotes+tags+heads --
// so indexing walked commits from AFTER the cutoff. Measured drift when it was
// caught: curl +9,798 commits, redis +8,760, caddy +2,723, zod +983,
// requests +241, ripgrep +40. 22,545 post-cutoff commits in total.
//
// That is a correctness fault, not a size one. A "when was X first introduced"
// answer could be a commit the pinned corpus is not supposed to contain, which
// makes the gold labels meaningless in both directions.
//
// HEAD alone is not sufficient evidence: HEAD matched the cutoff in all six
// clones the whole time the contamination was present. Reachability is what
// matters, so that is what this checks.
//
//   node bench/verify-external-clones.mjs [--dir <path>]

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchWorkSubdir } from './lib/workdir.mjs';

const DATASET = fileURLToPath(new URL('./dataset/external-v2.json', import.meta.url));

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

const dirArg = process.argv.indexOf('--dir');
const root = dirArg >= 0 ? process.argv[dirArg + 1] : benchWorkSubdir('external');
const { repositories } = JSON.parse(readFileSync(DATASET, 'utf8'));

let failed = 0;
for (const repo of repositories) {
  const path = join(root, repo.id);
  if (!existsSync(join(path, '.git'))) {
    console.error(`[MISSING] ${repo.id}: no clone at ${path}`);
    failed += 1;
    continue;
  }

  const head = git(path, ['rev-parse', 'HEAD']);
  const reachable = Number(git(path, ['rev-list', '--all', '--count']));
  const expected = repo.reachableCommitCount;

  const problems = [];
  if (head !== repo.cutoffSha) problems.push(`HEAD ${head} != cutoff ${repo.cutoffSha}`);
  if (reachable !== expected) {
    problems.push(`${reachable} commits reachable via --all, expected ${expected}`);
  }
  // Any ref that is not an ancestor of the cutoff can only reach later history.
  for (const ref of git(path, ['for-each-ref', '--format=%(refname)'])
    .split('\n')
    .filter(Boolean)) {
    try {
      execFileSync('git', ['-C', path, 'merge-base', '--is-ancestor', ref, repo.cutoffSha], {
        stdio: 'ignore',
      });
    } catch {
      problems.push(`ref ${ref} is not an ancestor of the cutoff`);
    }
  }

  if (problems.length > 0) {
    console.error(`[DIRTY] ${repo.id}: ${problems.join('; ')}`);
    failed += 1;
  } else {
    console.log(`[clean] ${repo.id}: ${reachable} commits, HEAD at cutoff`);
  }
}

if (failed > 0) {
  console.error(
    `\n${failed} clone(s) do not match their pin. Do NOT run external-v2 or the ` +
      `temporal stratum against these -- the numbers would be measured over history ` +
      `the pinned corpus is not supposed to contain. Re-prune or re-clone first.`,
  );
  process.exit(1);
}
console.log(`\nAll ${repositories.length} clones match their pins exactly.`);
