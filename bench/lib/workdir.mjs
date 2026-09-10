// Where benchmark scratch state lives.
//
// It used to live under `bench/work/` inside the repository tree. That was the
// root cause of the invalid 2026-09-09 agent pilot: OpenCode re-rooted every
// session from the trial clone up to the outer git-why repository, so agents
// worked in the wrong repository, read evaluator material, and wrote task
// answers into `src/`. Scratch state now lives outside any git worktree by
// default so that mistake is not reachable.
//
// Override with BENCH_WORK_DIR. The per-repository hash keeps two checkouts of
// git-why from colliding in the shared cache.

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

function repoHash() {
  return createHash('sha256').update(REPO_ROOT).digest('hex').slice(0, 12);
}

/** Root for all benchmark scratch state. Never inside the repository tree. */
export function benchWorkDir() {
  const override = process.env.BENCH_WORK_DIR;
  if (override && override.trim() !== '') return resolve(override);
  return join(homedir(), '.cache', 'git-why-bench', repoHash());
}

/** A named subdirectory of the scratch root, e.g. 'fixtures', 'agents-runs'. */
export function benchWorkSubdir(...parts) {
  return join(benchWorkDir(), ...parts);
}

export { REPO_ROOT };
