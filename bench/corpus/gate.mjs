#!/usr/bin/env node
/**
 * Keeps only the cases cheap search cannot already answer.
 *
 * Git Why's claim is about questions you cannot formulate as a search term. A
 * case that `git log --grep` or `git log -S` already answers is not evidence
 * either way, so it is discarded. This deliberately makes the corpus HARD by
 * construction, and the scope limit has to be stated with any number drawn
 * from it: these are the cases keyword search fails on, not a random sample of
 * developer questions.
 *
 * Run after paraphrasing. Running it before is useless -- a question quoted
 * from a commit body shares that commit's words, so grep finds it every time
 * and the gate rejects everything.
 *
 *   node bench/corpus/gate.mjs [--in paraphrased.json] [--out cases.json]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchWorkSubdir } from '../lib/workdir.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const IN = join(ROOT, arg('in', 'bench/corpus/paraphrased.json'));
const OUT = join(ROOT, arg('out', 'bench/corpus/cases.json'));
const REPOS = arg('repos', benchWorkSubdir('external'));

function git(repo, args) {
  try {
    return execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 60_000,
    });
  } catch {
    return '';
  }
}

const STOP = new Set(
  (
    'the a an and or but for with that this from into when what which why how does do did is are was were be ' +
    'been being have has had will would should could can may might must not no yes if then else than there ' +
    'their they them it its our we you your i me my used using still able only ever after before some thing ' +
    'stuff happened issue problem bug where suddenly kept made make making got get'
  ).split(/\s+/),
);
const terms = (t) => [
  ...new Set((t.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? []).filter((w) => !STOP.has(w))),
];

/** True when a developer typing this question's own words would find the answer. */
function answerable(repo, question, sha) {
  const words = terms(question).slice(0, 8);
  if (words.length === 0) return true;

  const any = ['log', '--format=%H', '-i', '--max-count=5'];
  for (const w of words) any.push(`--grep=${w}`);
  if (git(repo, any).split('\n').filter(Boolean).includes(sha)) return true;

  for (const n of [4, 3, 2]) {
    const all = ['log', '--format=%H', '-i', '--all-match', '--max-count=10'];
    for (const w of words.slice(0, n)) all.push(`--grep=${w}`);
    if (git(repo, all).split('\n').filter(Boolean).includes(sha)) return true;
  }

  const rarest = [...words].sort((a, b) => b.length - a.length).slice(0, 2);
  for (const w of rarest) {
    if (
      git(repo, ['log', '--format=%H', '--max-count=5', `-S${w}`])
        .split('\n')
        .filter(Boolean)
        .includes(sha)
    ) {
      return true;
    }
  }
  return false;
}

const data = JSON.parse(readFileSync(IN, 'utf8'));
const kept = [];
let rejected = 0;
for (const c of data.cases) {
  const repo = join(REPOS, c.repositoryId);
  if (!existsSync(join(repo, '.git'))) continue;
  if (answerable(repo, c.question, c.relevantShas[0])) {
    rejected += 1;
    continue;
  }
  kept.push(c);
}

const byRepo = {};
for (const c of kept) byRepo[c.repositoryId] = (byRepo[c.repositoryId] ?? 0) + 1;

writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      // Repository-relative: this file is committed, and an absolute path
      // records the author's checkout location while telling a reader nothing
      // they could use.
      derivedFrom: relative(ROOT, IN),
      scopeLimit:
        "Every case here is one that `git log --grep` and `git log -S` FAIL to answer from the question's own words. That is the point -- Git Why exists for questions you cannot turn into a search term -- but it means these numbers describe hard cases, not a random sample of developer questions. Keyword search would win on the easy ones, and does: on the unparaphrased corpus `git log --grep --all-match` scores 1.000 MRR.",
      kept: kept.length,
      rejectedAsAnswerableBySearch: rejected,
      byRepo,
      cases: kept,
    },
    null,
    2,
  )}\n`,
);
console.log(`kept ${kept.length}, rejected ${rejected} as answerable by plain search`);
console.log(byRepo);
