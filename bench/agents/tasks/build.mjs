#!/usr/bin/env node
// Builds each task's SOURCE repository (bench/work/agents-tasks/<id>/) and
// its manifest (bench/agents/tasks/manifests/<id>.json, committed). Hidden
// test files are written OUTSIDE any task repo, under
// bench/agents/tasks/hidden/<id>/, so they are never present in an
// agent-visible clone -- bench/agents/grade.mjs copies them in only after a
// trial ends, against a scratch copy of the trial's resulting worktree.

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { buildTaskRepo } from './lib/task-engine.mjs';

import t1 from './specs/t1.mjs';
import t2 from './specs/t2.mjs';
import t3 from './specs/t3.mjs';
import t4 from './specs/t4.mjs';
import t5 from './specs/t5.mjs';
import t6 from './specs/t6.mjs';
import t7 from './specs/t7.mjs';
import t8 from './specs/t8.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const WORK_DIR = join(REPO_ROOT, 'bench', 'work', 'agents-tasks');
const MANIFEST_DIR = join(HERE, 'manifests');
const HIDDEN_DIR = join(HERE, 'hidden');

const ALL_SPECS = [t1, t2, t3, t4, t5, t6, t7, t8];

function parseArgs(argv) {
  const only = argv.find((a) => a.startsWith('--only='));
  return { only: only ? only.slice('--only='.length).split(',') : null };
}

function main() {
  const { only } = parseArgs(process.argv.slice(2));
  const specs = only ? ALL_SPECS.filter((s) => only.includes(s.id)) : ALL_SPECS;

  for (const spec of specs) {
    const manifest = buildTaskRepo(spec, { workDir: WORK_DIR, manifestDir: MANIFEST_DIR });

    mkdirSync(join(HIDDEN_DIR, spec.id), { recursive: true });
    if (spec.hiddenTestFile) {
      writeFileSync(join(HIDDEN_DIR, spec.id, 'task.test.cjs'), spec.hiddenTestFile, 'utf8');
    }
    if (spec.rubric) {
      writeFileSync(join(HIDDEN_DIR, spec.id, 'rubric.json'), JSON.stringify(spec.rubric, null, 2) + '\n', 'utf8');
    }
    writeFileSync(
      join(HIDDEN_DIR, spec.id, 'meta.json'),
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
    writeFileSync(join(HIDDEN_DIR, spec.id, 'prompt.md'), spec.taskPrompt.trim() + '\n', 'utf8');

    console.log(`[${spec.id}] baseSha=${manifest.baseSha.slice(0, 12)} kind=${spec.kind} hiddenTest=${!!spec.hiddenTestFile} rubric=${!!spec.rubric}`);
  }
}

main();
