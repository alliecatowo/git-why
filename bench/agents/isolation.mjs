// Implements docs/spec.md section 20 EXACTLY: worktrees alone are
// insufficient (they share refs and objects), so efficacy trials get their
// own disposable clone built from a bundle that contains ONLY baseSha's
// ancestry.
//
// Flow per trial:
//   1. resolveBaseAncestry(sourceRepoDir, baseSha)     -- steps 1
//   2. exportCleanSeed(...)                             -- steps 2-3 (bundle + verify)
//   3. materializeTrialWorkspace(...)                   -- step 4 (disposable clone + detached worktree)
//
// Gold patches, expected SHAs, graders and hidden tests never enter any of
// these directories -- callers pass them in separately at grading time
// (see bench/agents/grade.mjs), never write them into a trial workspace.

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

function sh(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} (cwd=${cwd}) failed:\n${res.stdout}\n${res.stderr}`);
  }
  return res.stdout.trim();
}

/**
 * Step 1: resolve baseSha and its permitted ancestor set in the SOURCE repo
 * (the one that also contains held-out gold commits, per task-engine.mjs).
 */
export function resolveBaseAncestry(sourceRepoDir, baseSha) {
  const ancestors = sh(sourceRepoDir, ['rev-list', baseSha]).split('\n').filter(Boolean);
  return { baseSha, ancestors: new Set(ancestors) };
}

/**
 * Steps 2-3: bundle ONE temporary ref at baseSha (never --all) from the
 * source repo, verify the bundle, then verify the resulting object
 * inventory contains no SHA outside the permitted ancestor set (in
 * particular, no goldSha and nothing reachable only through it).
 */
export function exportCleanSeed(sourceRepoDir, baseSha, { workDir, label }) {
  const { ancestors } = resolveBaseAncestry(sourceRepoDir, baseSha);
  // Must live under refs/heads/ (not e.g. refs/tmp/): `git clone` only knows
  // how to check out a branch or HEAD, and a bundle's default checkout
  // target comes from a head-like ref.
  const branchName = `bench-seed-${label}`;
  const tmpRef = `refs/heads/${branchName}`;
  sh(sourceRepoDir, ['update-ref', tmpRef, baseSha]);

  workDir = resolve(workDir);
  mkdirSync(workDir, { recursive: true });
  const bundlePath = join(workDir, `${label}.bundle`);
  rmSync(bundlePath, { force: true });
  sh(sourceRepoDir, ['bundle', 'create', bundlePath, tmpRef]);
  sh(sourceRepoDir, ['update-ref', '-d', tmpRef]); // don't leave the temp ref lying around

  // Verify the bundle is self-contained and its history is exactly baseSha's
  // ancestry. `git bundle verify` needs to run inside SOME repository (any
  // repository -- it checks the bundle's prerequisites against it); the
  // source repo is convenient and still has every object at this point.
  sh(sourceRepoDir, ['bundle', 'verify', bundlePath]);
  const listOutput = sh(sourceRepoDir, ['bundle', 'list-heads', bundlePath]);
  if (!listOutput.includes(baseSha)) {
    throw new Error(`Bundle ${bundlePath} does not advertise baseSha ${baseSha} as a head.`);
  }

  return { bundlePath, ancestors, branchName };
}

/**
 * Step 4: a disposable clone from the bundle, with a detached worktree at
 * baseSha. Verifies (a) the clone's full object/ref inventory is a subset
 * of the permitted ancestor set, (b) no remote/alternate route back to the
 * full source repository survives, and (c) no held-out SHA (if provided)
 * is reachable or fetchable.
 */
export function materializeTrialWorkspace(bundlePath, baseSha, ancestors, { workDir, label, branchName }, heldOutShas = []) {
  workDir = resolve(workDir);
  mkdirSync(workDir, { recursive: true });
  const cloneDir = join(workDir, `${label}-clone`);
  rmSync(cloneDir, { recursive: true, force: true });
  sh(workDir, ['clone', '--no-local', '--branch', branchName, bundlePath, cloneDir]);

  // No alternates: a clone from a bundle should never reference the
  // filesystem it was bundled from.
  const alternatesFile = join(cloneDir, '.git', 'objects', 'info', 'alternates');
  if (existsSync(alternatesFile)) {
    throw new Error(`Trial clone ${cloneDir} has an object alternate; isolation is broken.`);
  }

  // No remotes pointing back at the source repo (bundle clones get an
  // "origin" remote pointing at the bundle FILE, which is fine and inert
  // once the workspace is detached from it below).
  sh(cloneDir, ['remote', 'remove', 'origin']);

  // Verify the object inventory is exactly baseSha's ancestry: every commit
  // reachable in the clone must be in the permitted ancestor set.
  const reachable = sh(cloneDir, ['rev-list', '--all']).split('\n').filter(Boolean);
  const leaked = reachable.filter((sha) => !ancestors.has(sha));
  if (leaked.length > 0) {
    throw new Error(`Trial clone ${cloneDir} contains commits outside baseSha's ancestry: ${leaked.join(', ')}`);
  }
  for (const heldOutSha of heldOutShas) {
    const exists = spawnSync('git', ['cat-file', '-e', heldOutSha], { cwd: cloneDir }).status === 0;
    if (exists) {
      throw new Error(`Trial clone ${cloneDir} can access held-out object ${heldOutSha}; isolation is broken.`);
    }
  }

  // Detached worktree at baseSha, then delete the seed branch entirely so
  // nothing named "bench-seed-*" survives for the agent to notice or push.
  sh(cloneDir, ['checkout', '--detach', baseSha]);
  sh(cloneDir, ['branch', '-D', branchName]);
  const head = sh(cloneDir, ['rev-parse', 'HEAD']);
  if (head !== baseSha) {
    throw new Error(`Trial clone ${cloneDir} HEAD is ${head}, expected ${baseSha}.`);
  }

  return { workspaceDir: cloneDir, verifiedAncestryCount: reachable.length };
}

/**
 * Convenience: build a fully isolated, disposable trial workspace for one
 * (task, arm, trial) combination in one call. Each call gets its own clone
 * directory (never shared/reused across trials, even for the same task).
 */
export function buildIsolatedTrialWorkspace({ sourceRepoDir, baseSha, goldSha, workRoot, trialLabel }) {
  const seedWorkDir = join(workRoot, 'seeds');
  const { bundlePath, ancestors, branchName } = exportCleanSeed(sourceRepoDir, baseSha, { workDir: seedWorkDir, label: trialLabel });
  const heldOutShas = goldSha ? [goldSha] : [];
  const { workspaceDir, verifiedAncestryCount } = materializeTrialWorkspace(
    bundlePath,
    baseSha,
    ancestors,
    { workDir: join(workRoot, 'trials'), label: trialLabel, branchName },
    heldOutShas,
  );
  return {
    workspaceDir,
    baseSha,
    verifiedAncestryCount,
    isolationReport: {
      bundlePath,
      heldOutShasChecked: heldOutShas,
      noAlternates: true,
      noLeakedCommits: true,
    },
  };
}
