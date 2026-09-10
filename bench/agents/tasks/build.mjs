#!/usr/bin/env node
// Builds each task's SOURCE repository (bench/work/agents-tasks/<id>/) and
// its manifest (bench/agents/tasks/manifests/<id>.json, committed). Hidden
// test files are written OUTSIDE any task repo, under
// bench/agents/tasks/hidden/<id>/, so they are never present in an
// agent-visible clone -- bench/agents/grade.mjs copies them in only after a
// trial ends, against a scratch copy of the trial's resulting worktree.

import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { buildTaskRepo } from './lib/task-engine.mjs';
import { benchWorkSubdir } from '../../lib/workdir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORK_DIR = benchWorkSubdir('agents-tasks');
// Only a non-sensitive catalog is committed. Prompts, hidden tests, rubrics,
// source locations, and held-out commits are evaluator material and belong
// outside every repository tree.
const CATALOG_DIR = join(HERE, 'manifests');
const EVALUATOR_DIR = benchWorkSubdir('evaluator', 'agents');
const PRIVATE_MANIFEST_DIR = join(EVALUATOR_DIR, 'manifests');
const PRIVATE_TASK_DIR = join(EVALUATOR_DIR, 'tasks');
const PRIVATE_CATALOG_PATH = join(EVALUATOR_DIR, 'specs', 'catalog.mjs');

function parseArgs(argv) {
  const only = argv.find((a) => a.startsWith('--only='));
  return { only: only ? only.slice('--only='.length).split(',') : null };
}

async function main() {
  if (!existsSync(PRIVATE_CATALOG_PATH)) {
    throw new Error(
      `Evaluator task specification package is missing: ${PRIVATE_CATALOG_PATH}. It is intentionally not kept in this repository.`,
    );
  }
  const { default: allSpecs } = await import(pathToFileURL(PRIVATE_CATALOG_PATH).href);
  const { only } = parseArgs(process.argv.slice(2));
  const specs = only ? allSpecs.filter((s) => only.includes(s.id)) : allSpecs;

  for (const spec of specs) {
    const manifest = spec.externalSource
      ? buildExternalTask(spec)
      : buildTaskRepo(spec, { workDir: WORK_DIR, manifestDir: PRIVATE_MANIFEST_DIR });

    mkdirSync(CATALOG_DIR, { recursive: true });
    writeFileSync(
      join(CATALOG_DIR, `${spec.id}.json`),
      JSON.stringify(
        {
          schemaVersion: manifest.schemaVersion,
          taskId: manifest.taskId,
          kind: manifest.kind,
          stratum: manifest.stratum,
          taskManifestVersion: manifest.taskManifestVersion,
          commitCount: manifest.commitCount,
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );

    mkdirSync(join(PRIVATE_TASK_DIR, spec.id), { recursive: true });
    if (spec.hiddenTestFile) {
      writeFileSync(join(PRIVATE_TASK_DIR, spec.id, 'task.test.cjs'), spec.hiddenTestFile, 'utf8');
    }
    if (spec.rubric) {
      writeFileSync(
        join(PRIVATE_TASK_DIR, spec.id, 'rubric.json'),
        JSON.stringify(spec.rubric, null, 2) + '\n',
        'utf8',
      );
    }
    writeFileSync(
      join(PRIVATE_TASK_DIR, spec.id, 'meta.json'),
      JSON.stringify(
        {
          taskId: spec.id,
          kind: spec.kind,
          baseSha: manifest.baseSha,
          goldSha: manifest.goldSha,
          successNote: spec.successNote,
          hasHiddenTest: !!spec.hiddenTestFile,
          hasRubric: !!spec.rubric,
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );
    writeFileSync(
      join(PRIVATE_TASK_DIR, spec.id, 'prompt.md'),
      spec.taskPrompt.trim() + '\n',
      'utf8',
    );

    console.log(
      `[${spec.id}] baseSha=${manifest.baseSha.slice(0, 12)} kind=${spec.kind} hiddenTest=${!!spec.hiddenTestFile} rubric=${!!spec.rubric}`,
    );
  }
}

function buildExternalTask(spec) {
  const sourceRepoDir = benchWorkSubdir('external', spec.externalSource.repositoryId);
  const count = spawnSync('git', ['rev-list', '--count', spec.externalSource.cutoffSha], {
    cwd: sourceRepoDir,
    encoding: 'utf8',
  });
  if (count.status !== 0) {
    throw new Error(
      `Pinned external clone unavailable for ${spec.id}: ${sourceRepoDir} at ${spec.externalSource.cutoffSha}`,
    );
  }
  const manifest = {
    schemaVersion: 2,
    taskId: spec.id,
    seed: spec.seed,
    kind: spec.kind,
    stratum: spec.stratum,
    taskManifestVersion: spec.taskManifestVersion,
    baseSha: spec.externalSource.cutoffSha,
    goldSha: null,
    priorShas: [],
    commitCount: Number(count.stdout.trim()),
    labels: { introducedSha: spec.externalSource.answerSha },
    sourceRepoDir,
    externalRepositoryId: spec.externalSource.repositoryId,
  };
  mkdirSync(PRIVATE_MANIFEST_DIR, { recursive: true });
  writeFileSync(
    join(PRIVATE_MANIFEST_DIR, `${spec.id}.json`),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  return manifest;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
