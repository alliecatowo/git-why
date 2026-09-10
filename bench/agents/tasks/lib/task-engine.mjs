// Builds one task's SOURCE repository: prior history (visible), the base
// commit (baseSha, the agent's starting point), and an optional gold-fix
// commit applied ON TOP of baseSha. The gold commit is never given a
// reachable ref other than one used to bundle it away; bench/agents/
// isolation.mjs is responsible for actually excluding it from any
// agent-visible seed by bundling only baseSha's ancestry.
//
// Deterministic from each task's seed, same contract as bench/fixtures/lib.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  initRepo,
  writeRepoFile,
  removeRepoFile,
  commitAll,
  git,
} from '../../../fixtures/lib/git.mjs';

export function buildTaskRepo(spec, { workDir, manifestDir }) {
  const dir = `${workDir}/${spec.id}`;
  initRepo(dir);
  let epoch = spec.baseEpochSeconds;

  const priorShas = [];
  // A benchmark task must look like an actual repository, not a three-commit
  // puzzle.  Padding is deliberately committed before the authored history:
  // it gives lexical retrieval realistic near-misses without leaking a later
  // answer into the trial head.
  for (let i = 0; i < (spec.historyPadding ?? 0); i++) {
    const topic = spec.distractorTerms?.[i % spec.distractorTerms.length] ?? 'maintenance';
    const path = `notes/release-${String(i).padStart(3, '0')}.md`;
    writeRepoFile(
      dir,
      path,
      `# Change note ${i + 1}\n\nRoutine ${topic} follow-up for an unrelated subsystem.\n`,
    );
    const sha = commitAll(dir, {
      message: `chore: ${topic} follow-up ${String(i + 1).padStart(3, '0')}`,
      epochSeconds: epoch,
    });
    priorShas.push({ sha, message: `chore: ${topic} follow-up`, role: 'distractor' });
    epoch += 3600;
  }
  // Churn on the files the task will ask about, committed BEFORE the
  // authored history.
  //
  // Without it, `git log -- src/dispatcher.js` returned three commits and the
  // second was the revert that explains everything, so the hazard was one
  // plain command away and the task measured nothing. Real files carry
  // hundreds of commits; the reason a revert is hard to find is that it sits
  // in a haystack, and the rationale lives in a message body that
  // `--oneline` does not show.
  for (let i = 0; i < (spec.filechurn ?? 0); i += 1) {
    for (const path of spec.churnPaths ?? []) {
      writeRepoFile(dir, path, `${readIfExists(dir, path)}\n// touched: pass ${i}\n`);
    }
    const sha = commitAll(dir, {
      message: `chore: routine upkeep pass ${String(i).padStart(3, '0')}`,
      epochSeconds: epoch,
    });
    priorShas.push({ sha, message: 'chore: routine upkeep', role: 'churn' });
    epoch += 3600;
  }

  for (const step of spec.priorHistory ?? []) {
    applyFiles(dir, step.files);
    const sha = commitAll(dir, { message: step.message, epochSeconds: epoch });
    priorShas.push({ sha, message: step.message, role: step.role ?? 'history', label: step.label });
    epoch += 3600;
  }

  // Churn AFTER the hazard, so the revert is buried mid-history rather than
  // sitting two lines from HEAD. Pre-hazard churn alone left
  // `git log -- <file>` showing the revert as its second entry, which is
  // still one glance away. A real warning is old and has had traffic on top
  // of it since.
  for (let i = 0; i < (spec.filechurnAfter ?? 0); i += 1) {
    for (const path of spec.churnPaths ?? []) {
      writeRepoFile(dir, path, `${readIfExists(dir, path)}\n// upkeep: later pass ${i}\n`);
    }
    const sha = commitAll(dir, {
      message: `chore: follow-up maintenance ${String(i).padStart(3, '0')}`,
      epochSeconds: epoch,
    });
    priorShas.push({ sha, message: 'chore: follow-up maintenance', role: 'churn' });
    epoch += 3600;
  }

  applyFiles(dir, spec.baseCommit.files);
  const baseSha = commitAll(dir, {
    message: spec.baseCommit.message,
    epochSeconds: epoch,
    allowEmpty: spec.baseCommit.files.length === 0,
  });
  epoch += 3600;

  let goldSha = null;
  if (spec.goldFix) {
    applyFiles(dir, spec.goldFix.files);
    goldSha = commitAll(dir, { message: spec.goldFix.message, epochSeconds: epoch });
    // Reset main back to baseSha: the gold fix must not be reachable from any
    // branch the agent could see. It stays as a dangling commit in THIS
    // source repo only, reachable solely by its SHA (recorded in the
    // manifest for grading), never exported by bench/agents/isolation.mjs.
    git(dir, ['update-ref', 'refs/heads/main', baseSha]);
    git(dir, ['reset', '--hard', 'main']);
  }

  mkdirSync(manifestDir, { recursive: true });
  const manifest = {
    schemaVersion: 2,
    taskId: spec.id,
    seed: spec.seed,
    kind: spec.kind,
    stratum: spec.stratum,
    taskManifestVersion: 'agent-corpus-v2',
    baseSha,
    goldSha,
    priorShas,
    commitCount: priorShas.length + 1,
    labels: Object.fromEntries(
      priorShas.filter((entry) => entry.label).map((entry) => [entry.label, entry.sha]),
    ),
    sourceRepoDir: dir,
  };
  writeFileSync(`${manifestDir}/${spec.id}.json`, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

/** Current content of a file, or empty string when it does not exist yet. */
function readIfExists(dir, path) {
  try {
    return readFileSync(`${dir}/${path}`, 'utf8');
  } catch {
    return '';
  }
}

function applyFiles(dir, files) {
  for (const f of files) {
    if (f.op === 'remove') {
      removeRepoFile(dir, f.path);
    } else {
      writeRepoFile(dir, f.path, f.content);
    }
  }
}
