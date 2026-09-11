#!/usr/bin/env node
/**
 * Recomputes citation grades from persisted answers.
 *
 * Grading is a pure function of the final answer and the gold commits, so it
 * can be redone without re-running a single agent. That matters: changing the
 * grader mid-suite would grade early models by one rule and later ones by
 * another, which is the same failure as measuring two different tools. Running
 * the new rule over every stored answer applies it uniformly instead.
 *
 * The rule this exists for: a citation must RESOLVE to a commit.
 *
 * The extractor matches seven-to-forty hex characters, which also matches long
 * decimal numbers -- byte counts, issue numbers, line offsets. Two such tokens
 * appeared in the first model's answers, and while neither matched a gold
 * commit, three of the 36 gold commits across the brief tasks begin with seven
 * digits. A commit body saying "5825605 bytes" would have been credited as
 * citing 5825605edb86.
 *
 *   node bench/agents/regrade.mjs [--run <pilot-dir>] [--write]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchWorkSubdir } from '../lib/workdir.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const write = process.argv.includes('--write');
const runsDir = join(ROOT, 'bench', 'results', 'agents');
const runName = arg('run', null);
const runs = runName
  ? [runName]
  : readdirSync(runsDir).filter((n) => n.startsWith('pilot-') || n.startsWith('smoke-'));
const manifestDir = join(benchWorkSubdir('evaluator', 'agents'), 'manifests');

/** Resolving the same abbreviation repeatedly is the slow part. */
const resolved = new Map();
function resolvesToCommit(repo, token) {
  const key = repo + ' ' + token;
  if (resolved.has(key)) return resolved.get(key);
  let ok = false;
  try {
    execFileSync('git', ['-C', repo, 'cat-file', '-e', token + '^{commit}'], { stdio: 'ignore' });
    ok = true;
  } catch {
    ok = false;
  }
  resolved.set(key, ok);
  return ok;
}

function regrade({ goldShas, answer, patch, repo }) {
  const haystack = (answer ?? '') + '\n' + (patch ?? '');
  const candidates = [...new Set(haystack.match(/\b[0-9a-f]{7,40}\b/g) ?? [])].map((s) =>
    s.toLowerCase(),
  );
  // A token that names no commit is not a citation, whatever it looks like.
  const cited = repo === null ? candidates : candidates.filter((c) => resolvesToCommit(repo, c));
  const found = goldShas.map((gold) => {
    const g = String(gold).toLowerCase();
    return cited.some((c) => g.startsWith(c) || c.startsWith(g));
  });
  return {
    score: found.filter(Boolean).length,
    outOf: goldShas.length,
    found,
    citedShaCount: cited.length,
    rejectedNonCommits: candidates.length - cited.length,
    citedGoldSha: found.some(Boolean),
    goldSha: goldShas[0],
  };
}

let changed = 0;
let examined = 0;
for (const run of runs) {
  const trialsDir = join(runsDir, run, 'trials');
  const artifactsDir = join(runsDir, run, 'artifacts');
  if (!existsSync(trialsDir)) continue;
  for (const file of readdirSync(trialsDir).filter((n) => n.endsWith('.json'))) {
    const path = join(trialsDir, file);
    const trial = JSON.parse(readFileSync(path, 'utf8'));
    const grade = trial.evidence_grade;
    // Only briefs carry a per-question score; single-question tasks keep the
    // original binary grade and are left alone.
    if (!grade || !Array.isArray(grade.found)) continue;
    const manifestPath = join(manifestDir, trial.task_id + '.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const goldShas = manifest.labels?.briefGoldShas;
    if (!Array.isArray(goldShas)) continue;

    const key = file.replace(/\.json$/, '');
    const answerPath = join(artifactsDir, key, 'final-answer.txt');
    const patchPath = join(artifactsDir, key, 'final.patch');
    if (!existsSync(answerPath)) continue;

    const repo = existsSync(manifest.sourceRepoDir) ? manifest.sourceRepoDir : null;
    const next = regrade({
      goldShas,
      answer: readFileSync(answerPath, 'utf8'),
      patch: existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '',
      repo,
    });
    examined += 1;
    if (next.score !== grade.score) {
      changed += 1;
      const extra =
        next.rejectedNonCommits > 0
          ? '  (' + next.rejectedNonCommits + ' non-commit rejected)'
          : '';
      console.log(
        '  ' +
          trial.task_id +
          ' ' +
          trial.arm +
          ': ' +
          grade.score +
          '/' +
          grade.outOf +
          ' -> ' +
          next.score +
          '/' +
          next.outOf +
          extra,
      );
    }
    if (write) {
      trial.evidence_grade = next;
      writeFileSync(path, JSON.stringify(trial, null, 2) + '\n');
    }
  }
}

console.log(
  '\nregrade: examined ' +
    examined +
    ' brief trials, ' +
    changed +
    ' would change' +
    (write ? ' (written)' : ' (dry run; pass --write to apply)'),
);
