#!/usr/bin/env node
/**
 * Builds LONG multi-turn investigation tasks from the gated corpus.
 *
 * The archaeology tasks these replace asked one question, wanted one SHA, and
 * finished in five to thirteen tool calls. That measures a lookup. It cannot
 * distinguish a tool that helps an agent work from one that answers a single
 * question slightly faster, and a binary pass/fail per trial throws away most
 * of the information a run produces — at eight paired tasks per model, a
 * one-bit outcome is close to no signal at all.
 *
 * A brief asks six linked questions about one repository in one session. That
 * changes three things:
 *
 *   1. It is long. Six investigations in a session, each needing its own
 *      searching and verification.
 *   2. It is scored 0..6, not pass/fail. Six times the information per trial,
 *      from the same number of expensive agent sessions.
 *   3. Context accumulates. By question four the agent is carrying everything
 *      it has already read, which is exactly where a tool that returns large
 *      evidence blocks either earns its place or does not — and is invisible
 *      in a single-question task.
 *
 * The questions come from `bench/corpus/cases.json`, which is already gated:
 * every one is verified unanswerable by `git log --grep` or `git log -S` from
 * its own words. Nothing here invents a question or a gold commit.
 *
 *   node bench/agents/tasks/build-brief.mjs [--per-task 6] [--tasks 6]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchWorkSubdir } from '../../lib/workdir.mjs';
import { mulberry32, seedFromString } from '../../fixtures/lib/rng.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const CORPUS = join(ROOT, 'bench', 'corpus', 'cases.json');
const EVALUATOR = benchWorkSubdir('evaluator', 'agents');
const CLONES = benchWorkSubdir('external');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};
const perTask = arg('per-task', 6);
const taskCount = arg('tasks', 6);

const cases = JSON.parse(readFileSync(CORPUS, 'utf8')).cases;

/** A gold commit that is not reachable is not gradeable. */
function reachable(repoDir, sha) {
  try {
    execFileSync('git', ['-C', repoDir, 'cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const byRepo = new Map();
for (const c of cases) {
  const sha = (c.relevantShas ?? [])[0];
  if (!sha) continue;
  const dir = join(CLONES, c.repositoryId);
  if (!existsSync(join(dir, '.git'))) continue;
  if (!reachable(dir, sha)) continue;
  if (!byRepo.has(c.repositoryId)) byRepo.set(c.repositoryId, []);
  byRepo.get(c.repositoryId).push({ ...c, goldSha: sha });
}

// Deterministic selection: the same corpus produces the same tasks, so a
// re-run compares like with like rather than redrawing the questions.
const rng = mulberry32(seedFromString('git-why-brief-v1'));
const shuffle = (xs) => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// Round-robin across repositories so no single project dominates: redis and
// zod supply 69% of the corpus, and six tasks drawn at random would very
// likely be five of those two.
const pools = [...byRepo.entries()]
  .filter(([, list]) => list.length >= perTask)
  .sort((a, b) => a[0].localeCompare(b[0]))
  .map(([repo, list]) => ({ repo, list: shuffle(list) }));

if (pools.length === 0) {
  console.error('build-brief: no repository has enough gradeable cases. Clone the pinned repos.');
  process.exit(1);
}

const tasks = [];
for (let i = 0; i < taskCount; i++) {
  const pool = pools[i % pools.length];
  const picked = pool.list.splice(0, perTask);
  if (picked.length < perTask) continue;
  tasks.push({ repo: pool.repo, questions: picked, index: Math.floor(i / pools.length) + 1 });
}

const manifestDir = join(EVALUATOR, 'manifests');
mkdirSync(manifestDir, { recursive: true });

const built = [];
for (const task of tasks) {
  const taskId = `B-${task.repo}-${String(task.index).padStart(2, '0')}`;
  const taskDir = join(EVALUATOR, 'tasks', taskId);
  rmSync(taskDir, { recursive: true, force: true });
  mkdirSync(taskDir, { recursive: true });

  const repoDir = join(CLONES, task.repo);
  const head = execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();

  // The prompt names no tool. Tool choice is the treatment; naming one would
  // be leading the witness and the measurement would mean nothing.
  const prompt = [
    `# Engineering brief: ${task.repo}`,
    ``,
    `You are picking up work on \`${task.repo}\` and need to understand several`,
    `decisions in its history before you touch anything. This is a real`,
    `repository with a long history; the answers are in it.`,
    ``,
    `## What to produce`,
    ``,
    `A written brief answering **every** question below. For each one:`,
    ``,
    `- answer it in a sentence or two, in your own words;`,
    `- cite the commit SHA in this repository that establishes the answer;`,
    `- quote the line of that commit's message or diff that supports it.`,
    ``,
    `Number your answers to match the questions. Answer all ${task.questions.length}.`,
    ``,
    `If you genuinely cannot find a supporting commit for one of them, say so`,
    `for that question and move on to the next. An invented SHA is worse than`,
    `"not found", and giving up on the remaining questions is worse than both.`,
    ``,
    `Do not modify any files.`,
    ``,
    `## Questions`,
    ``,
    ...task.questions.map((q, i) => `${i + 1}. ${q.question}`),
    ``,
  ].join('\n');
  writeFileSync(join(taskDir, 'prompt.md'), prompt, 'utf8');

  writeFileSync(
    join(taskDir, 'meta.json'),
    `${JSON.stringify(
      {
        taskId,
        kind: 'brief',
        baseSha: head,
        goldSha: null,
        successNote: `Scored out of ${task.questions.length}: one point per question whose gold commit is cited anywhere in the brief. No hidden test; this asks for an investigation, not a code change.`,
        hasHiddenTest: false,
        hasRubric: false,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  writeFileSync(
    join(manifestDir, `${taskId}.json`),
    `${JSON.stringify(
      {
        schemaVersion: 2,
        taskId,
        kind: 'brief',
        stratum: 'archaeology',
        taskManifestVersion: 'brief-v1',
        baseSha: head,
        goldSha: null,
        labels: {
          // One gold commit per question, in question order, so a partial
          // brief scores exactly the questions it actually answered.
          briefGoldShas: task.questions.map((q) => q.goldSha),
          questionIds: task.questions.map((q) => q.id),
          originalFixSha: task.questions[0].goldSha,
        },
        sourceRepoDir: repoDir,
        repositoryId: task.repo,
        questionCount: task.questions.length,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  built.push({ taskId, repo: task.repo, questions: task.questions.length });
}

console.log(`build-brief: ${built.length} tasks, ${perTask} questions each\n`);
for (const b of built) console.log(`  ${b.taskId.padEnd(28)} ${b.questions} questions`);
console.log(`\nmanifests -> ${manifestDir}`);
