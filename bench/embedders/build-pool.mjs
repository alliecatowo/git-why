#!/usr/bin/env node
/**
 * Builds the fixed evaluation pool the embedder comparison runs against.
 *
 * Embedding every commit of six repositories with a transformer is hours of
 * CPU per model, which would make the comparison unaffordable and therefore
 * unrepeatable. Instead each repository contributes a fixed random sample of
 * commits plus every gold commit, and every model is scored against that same
 * pool.
 *
 * Two consequences, stated rather than buried:
 *
 *   - Absolute numbers here are EASIER than the product's, because the pool is
 *     smaller than the real history. They are not comparable to section 0.
 *   - The comparison BETWEEN models is fair, because the pool, the questions
 *     and the gold commits are identical for all of them. That is the question
 *     being asked.
 *
 * The sample is seeded, so the pool is the same on every machine and a later
 * model can be added without redrawing it.
 *
 *   node bench/embedders/build-pool.mjs [--per-repo 2000]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchWorkSubdir } from '../lib/workdir.mjs';
import { mulberry32, seedFromString } from '../fixtures/lib/rng.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const perRepo = Number(arg('per-repo', 2000));
const repos = arg('repos', benchWorkSubdir('external'));
const outFile = join(ROOT, 'bench', 'results', 'embedders', 'pool.json');

const cases = JSON.parse(readFileSync(join(ROOT, 'bench', 'corpus', 'cases.json'), 'utf8')).cases;

/** The text the product embeds for a commit: subject and body, not the diff. */
function commitText(repo, sha) {
  return execFileSync('git', ['-C', repo, 'log', '-1', '--format=%s%n%n%b', sha], {
    encoding: 'utf8',
    maxBuffer: 1e8,
  }).trim();
}

const byRepo = new Map();
for (const c of cases) {
  const gold = (c.relevantShas ?? [])[0];
  if (!gold) continue;
  if (!byRepo.has(c.repositoryId)) byRepo.set(c.repositoryId, { questions: [], gold: new Set() });
  byRepo.get(c.repositoryId).questions.push({ id: c.id, question: c.question, gold });
  byRepo.get(c.repositoryId).gold.add(gold);
}

const rng = mulberry32(seedFromString('git-why-embedder-pool-v1'));
const pool = [];
for (const [repositoryId, entry] of [...byRepo.entries()].sort()) {
  const repo = join(repos, repositoryId);
  if (!existsSync(join(repo, '.git'))) {
    console.error(`[skip] ${repositoryId}: no clone`);
    continue;
  }
  const all = execFileSync('git', ['-C', repo, 'log', '--format=%H'], {
    encoding: 'utf8',
    maxBuffer: 1e9,
  })
    .split('\n')
    .filter(Boolean);

  // Sample distractors, then union with the gold commits so every question is
  // answerable within the pool. A pool that omitted a gold commit would score
  // every model zero on that case and teach us nothing about any of them.
  const shuffled = [...all];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const chosen = new Set(shuffled.slice(0, perRepo));
  for (const g of entry.gold) chosen.add(g);

  const docs = [];
  for (const sha of chosen) {
    let text;
    try {
      text = commitText(repo, sha);
    } catch {
      continue;
    }
    if (text.length === 0) continue;
    docs.push({ sha, text });
  }
  pool.push({ repositoryId, docs, questions: entry.questions });
  console.log(
    `  ${repositoryId.padEnd(22)} ${String(docs.length).padStart(5)} docs, ${String(entry.questions.length).padStart(3)} questions`,
  );
}

mkdirSync(join(ROOT, 'bench', 'results', 'embedders'), { recursive: true });
writeFileSync(
  outFile,
  `${JSON.stringify(
    {
      note: 'Fixed evaluation pool for comparing embedders. Sampled with a fixed seed plus every gold commit. Absolute scores are EASIER than the product on full history; only the comparison between models is meaningful.',
      perRepo,
      repositories: pool.length,
      documents: pool.reduce((a, r) => a + r.docs.length, 0),
      questions: pool.reduce((a, r) => a + r.questions.length, 0),
      pool,
    },
    null,
    2,
  )}\n`,
);
console.log(
  `\n${pool.reduce((a, r) => a + r.docs.length, 0)} documents, ${pool.reduce((a, r) => a + r.questions.length, 0)} questions -> ${outFile}`,
);
