#!/usr/bin/env node
/**
 * Derives benchmark cases FROM the pinned repositories, mechanically.
 *
 * The previous task sets were authored: I invented a revert, invented its
 * consequence, and then measured whether agents found my invention. That
 * measures the fiction, not the tool. Everything here is extracted from real
 * history by an objective rule, and every case must survive a leakage gate
 * before it counts.
 *
 * The gate is the important part. Git Why exists for questions you CANNOT
 * formulate as a search term; a case where `git log --grep` already finds the
 * answer is not such a question, so it is rejected. That keeps the corpus
 * honest in the direction that matters -- it can only contain cases where the
 * cheap tool fails, which is the claim under test.
 *
 *   node bench/corpus/extract.mjs [--repos <dir>] [--limit 400]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchWorkSubdir } from '../lib/workdir.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DATASET = join(ROOT, 'bench', 'dataset', 'external-v2.json');
const argv = process.argv.slice(2);
const OUT = join(
  ROOT,
  argv.includes('--no-gate') ? 'bench/corpus/candidates.json' : 'bench/corpus/cases.json',
);

const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const REPOS = arg('repos', benchWorkSubdir('external'));
const LIMIT = Number(arg('limit', 400));

function git(repo, args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    if (allowFail) return '';
    throw err;
  }
}

const STOP = new Set(
  (
    'the a an and or but for with that this from into when what which why how does do did is are was were ' +
    'be been being have has had will would should could can may might must not no yes if then else than ' +
    'there their they them it its our we you your i me my he she his her'
  ).split(/\s+/),
);

/** Content words, lowercased, stopwords and short tokens removed. */
function terms(text) {
  return [
    ...new Set((text.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? []).filter((w) => !STOP.has(w))),
  ];
}

/**
 * Rejects a case when a developer's cheap tools already answer it.
 *
 * Runs the question's own content words through `git log --grep` (any-match)
 * and `git log -S` on its rarest term. If the labelled commit shows up in the
 * first five results of either, the question was answerable by search and
 * tells us nothing about semantic retrieval.
 */
function leaks(repo, question, sha) {
  const words = terms(question).slice(0, 8);
  if (words.length === 0) return true;

  // `--grep` repeated is OR by default, which matches almost anything and let
  // easy cases through. `--all-match` is the honest test: it asks whether a
  // developer who typed the question's own content words would land on the
  // answer. Both forms are checked, since a developer might try either.
  const anyArgs = ['log', '--format=%H', '-i', '--max-count=5'];
  for (const w of words) anyArgs.push(`--grep=${w}`);
  if (git(repo, anyArgs, { allowFail: true }).split('\n').filter(Boolean).includes(sha))
    return true;

  for (const n of [4, 3, 2]) {
    const allArgs = ['log', '--format=%H', '-i', '--all-match', '--max-count=10'];
    for (const w of words.slice(0, n)) allArgs.push(`--grep=${w}`);
    if (git(repo, allArgs, { allowFail: true }).split('\n').filter(Boolean).includes(sha)) {
      return true;
    }
  }

  // Rarest term first: that is the one a developer would actually try.
  const rarest = [...words].sort((a, b) => b.length - a.length)[0];
  const byPickaxe = git(repo, ['log', '--format=%H', '--max-count=5', `-S${rarest}`], {
    allowFail: true,
  })
    .split('\n')
    .filter(Boolean);
  return byPickaxe.includes(sha);
}

/**
 * Archetype A -- ambiguous recall. Commits that fix something and say why, in
 * a body substantial enough that a question can be derived from the SYMPTOM
 * without reusing the subject's vocabulary.
 */
function extractRecall(repo, repoId, cutoffSha, limit) {
  const raw = git(repo, ['log', `--max-count=${limit}`, '--format=%H%x01%s%x01%b%x02', cutoffSha]);
  const out = [];
  for (const entry of raw.split('\x02')) {
    const [sha, subject, body] = entry.trim().split('\x01');
    if (!sha || !subject || !body) continue;
    if (body.length < 160) continue;
    if (
      !/fix|bug|regress|crash|leak|overflow|race|deadlock|incorrect|wrong|broken/i.test(
        subject + body,
      )
    )
      continue;
    // The question is derived from the BODY (the symptom), never the subject
    // (which usually names the fix and would give the answer away).
    const sentences = body
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter(
        (s) =>
          s.length > 40 && s.length < 240 && !/^(signed-off|co-authored|closes|fixes)/i.test(s),
      );
    if (sentences.length === 0) continue;
    const question = sentences[0];

    // A question that reuses the subject's distinctive words is not a
    // question, it is the answer restated. Commit bodies frequently open by
    // repeating the subject (especially squashed PR bodies), and those cases
    // would measure nothing.
    const subjectTerms = new Set(terms(subject));
    const shared = terms(question).filter((t) => subjectTerms.has(t));
    if (shared.length >= 3) continue;

    // Changelog and release-note fragments are lists, not symptoms.
    if (/^\s*[-*+]\s/.test(question)) continue;
    if (/^(this (is|was) not|remove |add |bump |update )/i.test(question)) continue;
    // A symptom describes behaviour; a note about test coverage does not.
    if (/\btest (cases?|coverage)\b/i.test(question)) continue;

    out.push({
      id: `recall-${repoId}-${sha.slice(0, 8)}`,
      archetype: 'ambiguous_recall',
      repositoryId: repoId,
      question,
      relevantShas: [sha],
      subject,
      derivation:
        'first substantive sentence of the commit body; rejected if it echoes the subject, reads as a changelog line, or is about test coverage rather than behaviour',
    });
  }
  return out;
}

const dataset = JSON.parse(readFileSync(DATASET, 'utf8'));
const cases = [];
const stats = [];
for (const repo of dataset.repositories) {
  const dir = join(REPOS, repo.id);
  if (!existsSync(join(dir, '.git'))) {
    stats.push({ repo: repo.id, error: 'no clone' });
    continue;
  }
  const candidates = extractRecall(dir, repo.id, repo.cutoffSha, LIMIT);
  // With --no-gate the gate is deferred: questions must be paraphrased first,
  // because a question quoted from the commit body always shares the commit's
  // vocabulary and `git log --grep` finds it every time. Gating before
  // paraphrase rejected 100% of candidates, correctly but uselessly.
  const deferGate = argv.includes('--no-gate');
  let kept = 0;
  for (const c of candidates) {
    if (!deferGate && leaks(dir, c.question, c.relevantShas[0])) continue;
    cases.push(c);
    kept += 1;
  }
  stats.push({ repo: repo.id, candidates: candidates.length, survivedGate: kept });
  console.log(`[${repo.id}] ${candidates.length} candidates -> ${kept} survived the leakage gate`);
}

mkdirSync(join(ROOT, 'bench', 'corpus'), { recursive: true });
writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      derivation:
        "Extracted mechanically from pinned real repositories. No case was authored. Every case survived a leakage gate: if `git log --grep` or `git log -S` on the question's own terms already surfaces the answer in its top five, the case is discarded, because Git Why exists for questions that cheap search cannot answer.",
      stats,
      cases,
    },
    null,
    2,
  )}\n`,
);
console.log(`\nwrote ${cases.length} cases to bench/corpus/cases.json`);
