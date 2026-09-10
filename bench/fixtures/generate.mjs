#!/usr/bin/env node
// Builds all fixture histories (or a subset via --only) by driving real git
// commands, deterministically from each fixture's seed. Repos are written to
// bench/work/fixtures/<id> (gitignored, regenerated on demand); the small
// per-commit manifest each fixture produces IS committed under
// bench/fixtures/manifests/<id>.json so the dataset can reference stable
// SHAs without the generated repository itself being checked in.
//
// Usage:
//   node bench/fixtures/generate.mjs [--only=id1,id2] [--filler=N] [--verify-determinism]

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { buildFixture } from './lib/engine.mjs';
import { benchWorkSubdir } from '../lib/workdir.mjs';

import realtimeChat from './specs/realtime-chat.mjs';
import taskQueue from './specs/task-queue.mjs';
import authPlatform from './specs/auth-platform.mjs';
import dataPipeline from './specs/data-pipeline.mjs';
import apiGateway from './specs/api-gateway.mjs';
import buildTooling from './specs/build-tooling.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORK_DIR = benchWorkSubdir('fixtures');
const MANIFEST_DIR = join(HERE, 'manifests');

const ALL_SPECS = [realtimeChat, taskQueue, authPlatform, dataPipeline, apiGateway, buildTooling];

function parseArgs(argv) {
  const args = { only: null, filler: null, verifyDeterminism: false };
  for (const arg of argv) {
    if (arg.startsWith('--only=')) args.only = arg.slice('--only='.length).split(',');
    else if (arg.startsWith('--filler=')) args.filler = Number(arg.slice('--filler='.length));
    else if (arg === '--verify-determinism') args.verifyDeterminism = true;
  }
  return args;
}

function summarize(manifest) {
  const byCategory = {};
  for (const c of manifest.commits) {
    byCategory[c.category] = (byCategory[c.category] ?? 0) + 1;
  }
  return { commits: manifest.commitCount, objects: manifest.objectCount, byCategory };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const specs = args.only ? ALL_SPECS.filter((s) => args.only.includes(s.id)) : ALL_SPECS;
  if (specs.length === 0) {
    console.error(
      `No fixture matched --only=${args.only?.join(',')}. Known ids: ${ALL_SPECS.map((s) => s.id).join(', ')}`,
    );
    process.exit(1);
  }

  const results = [];
  for (const spec of specs) {
    const manifest = buildFixture(spec, {
      workDir: WORK_DIR,
      manifestDir: MANIFEST_DIR,
      fillerOverride: args.filler ?? undefined,
    });
    results.push({ id: spec.id, ...summarize(manifest), headSha: manifest.headSha });
    console.log(
      `[${spec.id}] ${manifest.commitCount} commits, head ${manifest.headSha.slice(0, 12)}`,
    );
  }

  if (args.verifyDeterminism) {
    console.log('\nRe-running each fixture to verify the head SHA is reproducible...');
    for (const spec of specs) {
      const before = JSON.parse(readFileSync(join(MANIFEST_DIR, `${spec.id}.json`), 'utf8'));
      const after = buildFixture(spec, {
        workDir: WORK_DIR,
        manifestDir: MANIFEST_DIR,
        fillerOverride: args.filler ?? undefined,
      });
      if (before.headSha !== after.headSha) {
        console.error(
          `NON-DETERMINISTIC: ${spec.id} produced ${before.headSha} then ${after.headSha}`,
        );
        process.exitCode = 1;
      } else {
        console.log(`[${spec.id}] deterministic: ${after.headSha.slice(0, 12)}`);
      }
    }
  }

  console.log('\nTotals:');
  const totalCommits = results.reduce((a, r) => a + r.commits, 0);
  console.log(`  fixtures: ${results.length}, total commits: ${totalCommits}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
