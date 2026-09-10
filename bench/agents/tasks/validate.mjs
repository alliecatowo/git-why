#!/usr/bin/env node
// Validates the committed task metadata and regenerated source repositories.
// This is intentionally independent of the runner: a task corpus can fail
// closed before an expensive agent session is started.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { benchWorkSubdir } from '../../lib/workdir.mjs';

const HERE = resolve('bench/agents/tasks');
const manifestDir = join(HERE, 'manifests');
const evaluatorRoot = benchWorkSubdir('evaluator', 'agents');
const privateManifestDir = join(evaluatorRoot, 'manifests');
const privateTaskDir = join(evaluatorRoot, 'tasks');
const sourceRoot = benchWorkSubdir('agents-tasks');
const ids = readdirSync(manifestDir)
  .filter((name) => /^T\d+\.json$/.test(name))
  .map((name) => name.slice(0, -5))
  .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));

const failures = [];
if (ids.length < 20) failures.push(`expected at least 20 manifests, found ${ids.length}`);
const strata = new Set();
for (const id of ids) {
  const publicManifest = JSON.parse(readFileSync(join(manifestDir, `${id}.json`), 'utf8'));
  if (Object.hasOwn(publicManifest, 'baseSha') || Object.hasOwn(publicManifest, 'goldSha'))
    failures.push(`${id}: public catalog leaks evaluator SHA material`);
  const privatePath = join(privateManifestDir, `${id}.json`);
  if (!existsSync(privatePath)) {
    failures.push(
      `${id}: private evaluator manifest missing; run node bench/agents/tasks/build.mjs`,
    );
    continue;
  }
  const manifest = JSON.parse(readFileSync(privatePath, 'utf8'));
  strata.add(manifest.stratum);
  if (manifest.taskManifestVersion !== 'agent-corpus-v2')
    failures.push(`${id}: wrong task manifest version`);
  if (!Number.isInteger(manifest.commitCount) || manifest.commitCount < 120)
    failures.push(`${id}: expected >=120 commits, got ${manifest.commitCount}`);
  if (!existsSync(join(privateTaskDir, id, 'prompt.md')))
    failures.push(`${id}: missing evaluator prompt`);
  const sourceDir = manifest.sourceRepoDir ?? join(sourceRoot, id);
  if (!existsSync(sourceDir)) {
    failures.push(
      `${id}: generated source repository missing; run node bench/agents/tasks/build.mjs`,
    );
    continue;
  }
  const count = spawnSync('git', ['rev-list', '--count', manifest.baseSha], {
    cwd: sourceDir,
    encoding: 'utf8',
  });
  if (count.status !== 0 || Number(count.stdout.trim()) !== manifest.commitCount)
    failures.push(`${id}: generated history does not match manifest commit count`);
  if (manifest.stratum === 'temporal' && manifest.kind !== 'external_history_question') {
    for (const label of ['introducedSha', 'removedSha']) {
      if (!manifest.labels?.[label]) failures.push(`${id}: temporal label ${label} missing`);
    }
  }
}
for (const expected of ['coding', 'rubric', 'temporal']) {
  if (!strata.has(expected)) failures.push(`missing ${expected} stratum`);
}

if (failures.length) {
  console.error(`Task corpus validation failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`Task corpus valid: ${ids.length} tasks; strata=${[...strata].sort().join(', ')}`);
