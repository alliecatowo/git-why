#!/usr/bin/env node
/**
 * External-validity check: runs the hand-authored cases in
 * bench/dataset/external.json against real, pinned public repositories.
 *
 * docs/spec.md section 18 asks for at least 12 manually inspected questions
 * over at least two public histories, with repository URL, license, cutoff SHA
 * and relevant SHAs pinned before the scorer runs. Authoring those cases is not
 * the same as executing them: without this runner the dataset is labelled
 * material, not measured evidence, and the report may not claim
 * real-repository validation.
 *
 * Usage:
 *   node bench/retrieval/run-external.mjs --repos=<dir>
 * where <dir> holds one clone per repository id, each checked out at its
 * pinned cutoff SHA with no post-cutoff objects reachable.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CLI = path.join(ROOT, 'dist', 'cli', 'main.js');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.join('=') || true];
  }),
);
if (!args.repos) {
  console.error('usage: node bench/retrieval/run-external.mjs --repos=<dir>');
  process.exit(2);
}

const dataset = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'bench', 'dataset', 'external.json'), 'utf8'),
);
const dirFor = new Map(
  dataset.repositories.map((r) => [
    r.id,
    path.join(String(args.repos), `${r.id.split('-').pop()}-cut`),
  ]),
);

/** Refuse to score against a working copy that can see past the cutoff. */
function assertCutoff(repoDir, cutoffSha) {
  const head = execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  if (head !== cutoffSha)
    throw new Error(`${repoDir}: HEAD ${head} is not the pinned cutoff ${cutoffSha}`);
}

const rows = [];
for (const repo of dataset.repositories) {
  const dir = dirFor.get(repo.id);
  if (!fs.existsSync(dir)) {
    console.error(`[skip] ${repo.id}: no clone at ${dir}`);
    continue;
  }
  assertCutoff(dir, repo.cutoffSha);

  for (const c of dataset.cases.filter((x) => x.repositoryId === repo.id)) {
    const started = Date.now();
    let ranked = [];
    let exitCode = 0;
    try {
      const out = execFileSync(
        process.execPath,
        [CLI, c.query, '-n', '5', '--json', '--no-refresh'],
        {
          cwd: dir,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          maxBuffer: 64 * 1024 * 1024,
        },
      );
      ranked = JSON.parse(out).results.map((r) => r.sha);
    } catch (err) {
      exitCode = err.status ?? 1;
    }
    const relevant = new Set(c.relevantShas ?? []);
    const firstHit = ranked.findIndex((s) => relevant.has(s));
    rows.push({
      id: c.id,
      repositoryId: c.repositoryId,
      split: c.split,
      category: c.category,
      query: c.query,
      relevantShas: [...relevant],
      rankedShas: ranked,
      exitCode,
      elapsedMs: Date.now() - started,
      hit1: relevant.size === 0 ? null : firstHit === 0,
      hit3: relevant.size === 0 ? null : firstHit >= 0 && firstHit < 3,
      hit5: relevant.size === 0 ? null : firstHit >= 0 && firstHit < 5,
      reciprocalRank: relevant.size === 0 ? null : firstHit >= 0 ? 1 / (firstHit + 1) : 0,
    });
  }
}

const answerable = rows.filter((r) => r.hit5 !== null);
const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
const summary = {
  generatedAt: new Date().toISOString(),
  repositories: dataset.repositories.map((r) => ({
    id: r.id,
    url: r.url,
    license: r.license,
    cutoffSha: r.cutoffSha,
  })),
  totalCases: rows.length,
  answerableCases: answerable.length,
  overall: {
    hit1: mean(answerable.map((r) => (r.hit1 ? 1 : 0))),
    hit3: mean(answerable.map((r) => (r.hit3 ? 1 : 0))),
    hit5: mean(answerable.map((r) => (r.hit5 ? 1 : 0))),
    mrr: mean(answerable.map((r) => r.reciprocalRank)),
  },
  bySplit: ['dev', 'test'].map((split) => {
    const s = answerable.filter((r) => r.split === split);
    return {
      split,
      n: s.length,
      hit5: mean(s.map((r) => (r.hit5 ? 1 : 0))),
      mrr: mean(s.map((r) => r.reciprocalRank)),
    };
  }),
  notBlinded: dataset.notBlinded,
};

const outDir = path.join(
  ROOT,
  'bench',
  'results',
  'external',
  new Date().toISOString().replace(/[:.]/g, '-'),
);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'per-query.json'), JSON.stringify(rows, null, 2));
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(`[bench/external] wrote ${rows.length} cases to ${outDir}`);
console.table(
  rows.map((r) => ({
    id: r.id,
    repo: r.repositoryId,
    split: r.split,
    category: r.category,
    hit1: r.hit1,
    hit5: r.hit5,
    rr: r.reciprocalRank,
  })),
);
console.log('overall:', JSON.stringify(summary.overall));
console.log('bySplit:', JSON.stringify(summary.bySplit));
