/**
 * Guards against benchmark task answers landing in the product tree.
 *
 * The 2026-09-09 agent pilot was invalidated partly because agents wrote task
 * files into the real repository: `src/utils.cjs` (a T7 answer) was committed,
 * and `src/config.cjs`, `src/gateway.cjs` and `ops/` were left untracked. T7
 * then failed in every arm because the answer was already sitting in `src/`.
 *
 * This test reads the paths every task spec writes and asserts none of them
 * exists in the shipped source tree. It is deliberately spec-driven rather
 * than a hardcoded denylist, so a new task automatically extends the guard.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { findRepoRoot } from '../repo-root.js';

const repoRoot = findRepoRoot(path.dirname(new URL(import.meta.url).pathname));
const specsDir = path.join(repoRoot, 'bench', 'agents', 'tasks', 'specs');

/**
 * Task specs are ESM modules with deeply nested template literals, so they are
 * scanned textually for `path: '...'` rather than imported: the guard must keep
 * working even if a spec fails to evaluate. The same key is used for HTTP
 * routes inside task fixtures, so leading-slash values are dropped.
 */
function taskPathsFromSpecs(): Set<string> {
  const found = new Set<string>();
  if (!fs.existsSync(specsDir)) return found;
  for (const entry of fs.readdirSync(specsDir)) {
    if (!entry.endsWith('.mjs')) continue;
    const source = fs.readFileSync(path.join(specsDir, entry), 'utf8');
    for (const match of source.matchAll(/\bpath:\s*'([^']+)'/g)) {
      const value = match[1]!;
      if (value.startsWith('/')) continue;
      found.add(value);
    }
  }
  return found;
}

/** Paths git knows about, so a genuine repository file is not mistaken for a leak. */
function trackedPaths(): Set<string> {
  const listed = execFileSync('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return new Set(listed.split('\0').filter((entry) => entry !== ''));
}

test('no benchmark task artifact exists in the product tree', () => {
  const taskPaths = taskPathsFromSpecs();
  assert.ok(taskPaths.size > 0, 'expected to find task file paths in bench/agents/tasks/specs');

  // Some task paths collide with ordinary repository files by name -- T8 writes
  // a `README.md`, and so does every project. Tracked files are therefore
  // exempt: a leaked artifact arrives as an untracked write from an agent, and
  // one that reaches a commit is caught by review and by the `.cjs` check below.
  const tracked = trackedPaths();
  const leaked: string[] = [];
  for (const rel of taskPaths) {
    // Task paths are repo-relative already (`src/session.cjs`, `ops/runbook.md`).
    if (tracked.has(rel)) continue;
    if (fs.existsSync(path.join(repoRoot, rel))) leaked.push(rel);
  }
  leaked.sort();

  assert.deepEqual(
    leaked,
    [],
    `benchmark task artifacts leaked into the repository: ${leaked.join(', ')}. ` +
      'Delete them; they are agent output, not product source.',
  );
});

test('the product source tree contains no CommonJS files', () => {
  // Every task spec writes `.cjs` files; `src/` is ESM TypeScript only. This
  // catches a leak even from a task whose spec was deleted after the fact.
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.cjs')) offenders.push(path.relative(repoRoot, full));
    }
  };
  walk(path.join(repoRoot, 'src'));
  assert.deepEqual(offenders, [], `unexpected CommonJS files under src/: ${offenders.join(', ')}`);
});

test('benchmark scratch state does not live inside the repository', () => {
  assert.equal(
    fs.existsSync(path.join(repoRoot, 'bench', 'work')),
    false,
    'bench/work/ is gone: scratch state lives under BENCH_WORK_DIR, outside any git worktree, ' +
      'so that an agent cannot re-root from a trial clone into this repository.',
  );
});
