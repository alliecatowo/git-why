// Generic fixture engine. A "spec" (see bench/fixtures/specs/*.mjs) supplies:
//   - id, seed, baseEpochSeconds
//   - initialFiles: [{ path, content }]           scaffold committed first
//   - beats: [{ id, category, subsystem, files, subject, body, note }]
//       authored, order-sensitive commits that dataset queries target.
//       files: [{ path, op: 'write'|'remove'|'rename', content?, fromPath? }]
//   - fillerPlan: { count, versionBumpFraction, distractorBeats }
//       distractorBeats: authored-style beats structurally similar to a real
//       fix but for the WRONG subsystem/constraint (category 'distractor').
//
// The engine interleaves filler commits between authored beats
// deterministically (positions chosen by a seeded RNG, not randomly at
// generation time), so re-running with the same seed reproduces identical
// commit SHAs. It writes bench/fixtures/manifests/<id>.json.

import { mkdirSync, writeFileSync } from 'node:fs';
import {
  initRepo,
  writeRepoFile,
  removeRepoFile,
  renameRepoFile,
  commitAll,
  currentHead,
  objectCount,
} from './git.mjs';
import { subRng, randInt, pick } from './rng.mjs';
import { CHURN_SUBJECTS, VERSION_BUMP_SUBJECTS, DEPENDENCIES, semverLike, CHURN_COMMENT_LINES } from './wordbank.mjs';

const SECONDS_PER_COMMIT = 3 * 60 * 60; // 3 hours apart, deterministic spacing

function applyFileOps(dir, files) {
  const touched = [];
  for (const f of files) {
    if (f.op === 'remove') {
      removeRepoFile(dir, f.path);
      touched.push(f.path);
    } else if (f.op === 'rename') {
      renameRepoFile(dir, f.fromPath, f.path);
      touched.push(f.path, f.fromPath);
    } else {
      writeRepoFile(dir, f.path, f.content);
      touched.push(f.path);
    }
  }
  return touched;
}

function fillerChurnBeat(rng, editableFiles) {
  const file = pick(rng, editableFiles);
  const subject = pick(rng, CHURN_SUBJECTS).replace('{file}', file.path);
  const line = pick(rng, CHURN_COMMENT_LINES);
  const newContent = `${file.content}\n${line}\n`;
  file.content = newContent; // keep our in-memory mirror consistent
  return {
    id: `filler.churn.${file.path}.${Math.floor(rng() * 1e9)}`,
    category: 'churn',
    subsystem: file.subsystem,
    files: [{ path: file.path, op: 'write', content: newContent }],
    subject,
    body: '',
    note: 'Ordinary churn: cosmetic edit, not a relevant answer to any query.',
  };
}

function versionBumpBeat(rng) {
  const dep = pick(rng, DEPENDENCIES);
  const version = semverLike(rng, randInt);
  const subject = pick(rng, VERSION_BUMP_SUBJECTS).replace('{dep}', dep).replace('{version}', version);
  const path = 'package-lock.snapshot.txt';
  return {
    id: `filler.version.${dep}.${version}`,
    category: 'version_distractor',
    subsystem: 'deps',
    files: [{ path, op: 'write', content: `${dep}@${version}\ngenerated: true\n` }],
    subject,
    body: '',
    note: 'Version-number distractor: an unrelated dependency bump that must not be confused with a real number/version query.',
  };
}

export function buildFixture(spec, { workDir, manifestDir, fillerOverride } = {}) {
  const rng = subRng(spec.seed, 'interleave');
  const dir = `${workDir}/${spec.id}`;
  initRepo(dir);

  const commits = [];
  let epoch = spec.baseEpochSeconds;

  // In-memory mirror of editable files so filler churn can append lines
  // without re-reading from disk (keeps content, hence SHAs, deterministic
  // and independent of filesystem read ordering).
  const editableFiles = [];
  for (const f of spec.initialFiles) {
    writeRepoFile(dir, f.path, f.content);
    editableFiles.push({ path: f.path, content: f.content, subsystem: f.subsystem ?? 'core' });
  }
  const scaffoldSha = commitAll(dir, {
    message: 'Initial scaffold',
    epochSeconds: epoch,
  });
  commits.push({
    sha: scaffoldSha,
    index: 0,
    epochSeconds: epoch,
    category: 'scaffold',
    subsystem: 'core',
    subject: 'Initial scaffold',
    files: spec.initialFiles.map((f) => f.path),
    note: 'Repository scaffold; not a query target.',
  });
  epoch += SECONDS_PER_COMMIT;

  const fillerCount = fillerOverride ?? spec.fillerPlan.count;
  const distractorBeats = spec.fillerPlan.distractorBeats ?? [];
  const versionFraction = spec.fillerPlan.versionBumpFraction ?? 0.15;

  // Build the full ordered beat list: authored beats keep their given order
  // (later beats may depend on earlier ones, e.g. a removal after an add).
  // Filler/distractor commits are assigned deterministic insertion slots
  // among the authored beats using the interleave RNG.
  const slots = spec.beats.length + 1; // gaps before/after/between authored beats
  const fillerAssignment = [];
  const totalFillerJobs = fillerCount + distractorBeats.length;
  for (let i = 0; i < totalFillerJobs; i++) {
    fillerAssignment.push(randInt(rng, 0, slots - 1));
  }

  let distractorIdx = 0;
  let versionCounter = 0;
  const fillerRng = subRng(spec.seed, 'filler-content');

  function runFillerJobs(slotIndex) {
    const count = fillerAssignment.filter((s) => s === slotIndex).length;
    for (let i = 0; i < count; i++) {
      let beat;
      if (distractorIdx < distractorBeats.length && fillerRng() < 0.4) {
        beat = distractorBeats[distractorIdx];
        distractorIdx++;
      } else if (versionCounter < Math.round(fillerCount * versionFraction) && fillerRng() < 0.5) {
        beat = versionBumpBeat(fillerRng);
        versionCounter++;
      } else if (editableFiles.length > 0) {
        beat = fillerChurnBeat(fillerRng, editableFiles);
      } else {
        continue;
      }
      const touched = applyFileOps(dir, beat.files);
      const message = beat.body ? `${beat.subject}\n\n${beat.body}` : beat.subject;
      const sha = commitAll(dir, { message, epochSeconds: epoch });
      commits.push({
        sha,
        index: commits.length,
        epochSeconds: epoch,
        category: beat.category,
        subsystem: beat.subsystem,
        subject: beat.subject,
        files: touched,
        note: beat.note ?? null,
      });
      epoch += SECONDS_PER_COMMIT;
    }
  }

  runFillerJobs(0);
  for (let i = 0; i < spec.beats.length; i++) {
    const beat = spec.beats[i];
    const touched = applyFileOps(dir, beat.files);
    // Track new/modified file content in our mirror so later filler churn
    // on the same path stays deterministic.
    for (const f of beat.files) {
      if (f.op === 'write') {
        const existing = editableFiles.find((e) => e.path === f.path);
        if (existing) existing.content = f.content;
        else editableFiles.push({ path: f.path, content: f.content, subsystem: beat.subsystem });
      } else if (f.op === 'remove') {
        const idx = editableFiles.findIndex((e) => e.path === f.path);
        if (idx >= 0) editableFiles.splice(idx, 1);
      } else if (f.op === 'rename') {
        const existing = editableFiles.find((e) => e.path === f.fromPath);
        if (existing) {
          existing.path = f.path;
        }
      }
    }
    const message = beat.body ? `${beat.subject}\n\n${beat.body}` : beat.subject;
    const sha = commitAll(dir, { message, epochSeconds: epoch });
    commits.push({
      sha,
      index: commits.length,
      epochSeconds: epoch,
      category: beat.category,
      subsystem: beat.subsystem,
      subject: beat.subject,
      files: touched,
      note: beat.note ?? null,
      beatId: beat.id,
    });
    epoch += SECONDS_PER_COMMIT;
    runFillerJobs(i + 1);
  }

  const headSha = currentHead(dir);
  const manifest = {
    fixtureId: spec.id,
    seed: spec.seed,
    theme: spec.theme,
    headSha,
    commitCount: commits.length,
    objectCount: objectCount(dir),
    commits,
  };
  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(`${manifestDir}/${spec.id}.json`, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}
