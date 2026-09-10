// Generates agent tasks from the hand-authored external-v2 questions, against
// the pinned real repositories.
//
// The synthetic tasks cannot discriminate. Two complete 48-trial runs scored
// 100% in every arm including the control, because the rationale commit sits
// one hop from HEAD in a 125-commit repository and `git log -S` returns two
// results -- plain Git wins without help, so no treatment can show an effect.
//
// These tasks put the same question in the regime Git Why is actually for: the
// originating commit is thousands of commits back, the messages are terse, and
// `git log -S "HTTP/3"` returns 103 candidates in curl's 30,000. The baseline
// arm can still succeed, but it has to work for it, which is what makes the
// comparison meaningful.
//
//   node bench/agents/tasks/build-real.mjs [--split=dev]

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchWorkSubdir } from '../../lib/workdir.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const DATASET = join(ROOT, 'bench', 'dataset', 'external-v2.json');
const EVALUATOR = benchWorkSubdir('evaluator', 'agents');
const CLONES = benchWorkSubdir('external');

const splitArg = process.argv.find((a) => a.startsWith('--split='));
const split = splitArg ? splitArg.slice('--split='.length) : 'dev';

const dataset = JSON.parse(readFileSync(DATASET, 'utf8'));
const repoById = new Map(dataset.repositories.map((r) => [r.id, r]));

/** Refuses to build a task whose gold commit is not actually reachable. */
function assertReachable(repoDir, sha, cutoffSha) {
  execFileSync('git', ['-C', repoDir, 'cat-file', '-e', sha]);
  execFileSync('git', ['-C', repoDir, 'merge-base', '--is-ancestor', sha, cutoffSha]);
}

const built = [];
for (const c of dataset.cases) {
  if (c.split !== split) continue;
  const gold = (c.relevantShas ?? [])[0];
  if (!gold) continue;

  const repo = repoById.get(c.repositoryId);
  const repoDir = join(CLONES, c.repositoryId);
  if (!existsSync(join(repoDir, '.git'))) {
    console.error(`[skip] ${c.id}: no clone at ${repoDir}`);
    continue;
  }
  try {
    assertReachable(repoDir, gold, repo.cutoffSha);
  } catch {
    console.error(`[skip] ${c.id}: gold ${gold.slice(0, 10)} not reachable from the cutoff`);
    continue;
  }

  const taskId = `X-${c.id.replace(/^ext2-[dt]-/, '')}`;
  const taskDir = join(EVALUATOR, 'tasks', taskId);
  mkdirSync(taskDir, { recursive: true });

  // The prompt states the question and asks for the commit, and says nothing
  // about which tools to use -- tool choice is the treatment, not the task.
  const prompt = [
    `# Repository archaeology`,
    ``,
    `You are in a checkout of \`${repo.url}\` at a pinned historical commit.`,
    `The repository has ${repo.reachableCommitCount.toLocaleString()} commits of history.`,
    ``,
    `## Question`,
    ``,
    c.query,
    ``,
    `## What to produce`,
    ``,
    `Answer the question, and cite the commit SHA in this repository's history`,
    `that establishes the answer. Quote the part of that commit's message or`,
    `diff that supports it. Do not modify any files.`,
    ``,
    `If you cannot find a supporting commit, say so plainly rather than`,
    `guessing a SHA. An invented SHA is worse than "not found".`,
  ].join('\n');
  writeFileSync(join(taskDir, 'prompt.md'), prompt, 'utf8');

  writeFileSync(
    join(taskDir, 'meta.json'),
    `${JSON.stringify(
      {
        taskId,
        kind: 'archaeology',
        baseSha: repo.cutoffSha,
        goldSha: null,
        successNote:
          'Graded on whether the cited commit matches the hand-verified relevant SHA. No hidden test: this task asks a question, it does not ask for a code change.',
        hasHiddenTest: false,
        hasRubric: false,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  mkdirSync(join(EVALUATOR, 'manifests'), { recursive: true });
  writeFileSync(
    join(EVALUATOR, 'manifests', `${taskId}.json`),
    `${JSON.stringify(
      {
        schemaVersion: 2,
        taskId,
        kind: 'archaeology',
        stratum: 'archaeology',
        taskManifestVersion: 'external-v2-real',
        baseSha: repo.cutoffSha,
        goldSha: null,
        // The grader reads originalFixSha; this is the hand-verified commit.
        labels: { originalFixSha: gold },
        sourceRepoDir: repoDir,
        commitCount: repo.reachableCommitCount,
        caseId: c.id,
        repositoryId: c.repositoryId,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  built.push({ taskId, repo: c.repositoryId, commits: repo.reachableCommitCount });
}

for (const b of built) console.log(`[ok] ${b.taskId} ${b.repo} (${b.commits} commits)`);
console.log(`\nbuilt ${built.length} real-repository tasks (split=${split})`);
console.log(built.map((b) => b.taskId).join(','));
