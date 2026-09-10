#!/usr/bin/env node
// Benchmark C: CLI performance and parallel load (docs/spec.md section 24).
// Drives the built CLI exclusively through its documented external surface.
// Fails loudly if dist/cli/main.js is missing rather than emitting
// placeholder numbers.
//
// Usage:
//   node bench/perf/run.mjs [--fixture=task-queue] [--repo=/abs/path/to/real/clone]
//   node bench/perf/run.mjs --only=firstUse,concurrentReaders
//
// KNOWN GAPS (reported in the summary, not hidden):
//   - Per-phase timing breakdown (detection/fingerprint/lock/refresh/model
//     load/query embedding/lexical/vector/grouping/render) is not part of
//     the frozen --json SearchResponse contract (src/types.ts) as of this
//     writing, so it cannot be measured without importing product
//     internals, which bench/ may not do. Only externally observable total
//     wall time is reported; internal-phase reconciliation is marked
//     "not measurable via the external surface" rather than fabricated.
//   - "Loaded-process query loop" has no documented in-process repeat mode
//     in the section 5 command contract, so it is approximated by back-to-
//     back warm fresh-process calls and labeled accordingly -- NOT a true
//     loaded-process number.
//   - Reference corpus is a synthetic bench fixture (max ~166 commits), not
//     the 10k-commit representative corpus section 24 targets. Pass
//     --repo=/abs/path to a real large local clone to extend coverage; none
//     is bundled or auto-cloned here (see bench/README.md).

import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  hardwareInfo,
  resolveCli,
  runOnce,
  runAsyncWithMemorySampling,
  summarizeLatencies,
  cloneFixtureForPerf,
  isolatedCacheEnv,
  dirSizeBytes,
} from './lib.mjs';
import { commitAll, writeRepoFile, git } from '../fixtures/lib/git.mjs';
import { benchWorkSubdir } from '../lib/workdir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

const FIXTURES_MANIFEST_DIR = join(REPO_ROOT, 'bench', 'fixtures', 'manifests');
const FIXTURES_WORK_DIR = benchWorkSubdir('fixtures');
const PERF_WORK_DIR = benchWorkSubdir('perf');
const RESULTS_DIR = join(REPO_ROOT, 'bench', 'results', 'perf');

function parseArgs(argv) {
  const args = { fixture: 'task-queue', repo: null, only: null };
  for (const a of argv) {
    if (a.startsWith('--fixture=')) args.fixture = a.slice('--fixture='.length);
    else if (a.startsWith('--repo=')) args.repo = resolve(a.slice('--repo='.length));
    else if (a.startsWith('--only=')) args.only = a.slice('--only='.length).split(',');
  }
  return args;
}

function fail(msg) {
  console.error(`\n[bench/perf] FAILED: ${msg}\n`);
  process.exit(1);
}

function ensureBaseFixture(fixtureId) {
  const manifestPath = join(FIXTURES_MANIFEST_DIR, `${fixtureId}.json`);
  if (!existsSync(manifestPath))
    fail(`Unknown fixture "${fixtureId}" (no manifest at ${manifestPath}).`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const dir = join(FIXTURES_WORK_DIR, fixtureId);
  const head = (() => {
    try {
      return git(dir, ['rev-parse', 'HEAD']);
    } catch {
      return null;
    }
  })();
  if (head !== manifest.headSha) {
    fail(
      `Fixture "${fixtureId}" is missing or stale. Run: node bench/fixtures/generate.mjs --only=${fixtureId}`,
    );
  }
  return { dir, manifest };
}

function statusJson(cliPath, cwd, env = {}) {
  const res = runOnce(cliPath, ['status', '--json'], { cwd, env });
  return res;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cliPath = (() => {
    try {
      return resolveCli(REPO_ROOT, 'dist/cli/main.js');
    } catch (err) {
      fail(err.message);
    }
  })();

  const { dir: baseFixtureDir, manifest: baseManifest } = ensureBaseFixture(args.fixture);
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(RESULTS_DIR, runId);
  mkdirSync(outDir, { recursive: true });

  const results = {
    runId,
    generatedAt: new Date().toISOString(),
    hardware: hardwareInfo(),
    referenceCorpus: {
      kind: args.repo ? 'pinned-public-repo' : 'synthetic-bench-fixture',
      fixtureId: args.repo ? null : args.fixture,
      path: args.repo ?? baseFixtureDir,
      commitCount: args.repo ? null : baseManifest.commitCount,
    },
    knownGaps: [
      'Per-phase timing breakdown is not part of the frozen --json contract; only total external wall time is measured.',
      'Loaded-process query loop is approximated via warm fresh-process calls, not a true in-process repeat.',
      args.repo
        ? null
        : 'No pinned public repository was supplied (--repo=); reference corpus is a synthetic fixture, not the 10k-commit target scale.',
    ].filter(Boolean),
    workloads: {},
  };

  const only = (id) => !args.only || args.only.includes(id);
  const QUERY = 'why did this change';

  // ---- 1 & 2: first use, missing model / cached model -------------------
  if (only('firstUse')) {
    const cacheDir = join(PERF_WORK_DIR, 'model-cache', runId);
    const cacheEnv = isolatedCacheEnv(cacheDir);
    const missingModelRepo = cloneFixtureForPerf(
      baseFixtureDir,
      PERF_WORK_DIR,
      'first-use-missing-model',
    );
    rmSync(join(missingModelRepo, '.git', 'why'), { recursive: true, force: true }); // in case a stray index dir exists
    const before = dirSizeBytes(cacheDir);
    const missing = runOnce(cliPath, [QUERY, '--json'], {
      cwd: missingModelRepo,
      env: cacheEnv,
      timeoutMs: 10 * 60_000,
    });
    const after = dirSizeBytes(cacheDir);
    const cacheGrew = (after ?? 0) > (before ?? 0);

    const cachedModelRepo = cloneFixtureForPerf(
      baseFixtureDir,
      PERF_WORK_DIR,
      'first-use-cached-model',
    );
    rmSync(join(cachedModelRepo, '.git', 'why'), { recursive: true, force: true });
    const cached = runOnce(cliPath, [QUERY, '--json'], {
      cwd: cachedModelRepo,
      env: cacheEnv,
      timeoutMs: 10 * 60_000,
    });

    results.workloads.firstUse = {
      cacheOverrideVerified: cacheGrew,
      cacheOverrideCaveat: cacheGrew
        ? null
        : 'The isolated HOME/XDG_CACHE_HOME override did not visibly grow the temp cache dir. Either the model was ' +
          'already resident some other way, or the product does not key its cache off these env vars. Treat the ' +
          '"missing model" number below as UNVERIFIED, not as ground truth.',
      missingModel: {
        totalMs: missing.elapsedMs,
        exitCode: missing.exitCode,
        error: missing.exitCode === 0 ? null : missing.stderr || missing.stdout,
      },
      cachedModel: {
        totalMs: cached.elapsedMs,
        exitCode: cached.exitCode,
        error: cached.exitCode === 0 ? null : cached.stderr || cached.stdout,
      },
      networkTransferDeltaMs:
        missing.exitCode === 0 && cached.exitCode === 0
          ? missing.elapsedMs - cached.elapsedMs
          : null,
    };
  }

  // ---- 3: fresh CLI process, current index (>=30 warm-cache samples) ----
  let warmRepo = null;
  if (
    only('freshProcessCurrentIndex') ||
    only('loadedProcessQueryLoop') ||
    only('oneNewCommit') ||
    only('tenNewCommits') ||
    only('unchangedRefs') ||
    only('renameRebaseBranchDeletion') ||
    only('concurrentReaders') ||
    only('readersPlusUpdater')
  ) {
    warmRepo = cloneFixtureForPerf(baseFixtureDir, PERF_WORK_DIR, 'warm-reference');
    rmSync(join(warmRepo, '.git', 'why'), { recursive: true, force: true });
    const build = runOnce(cliPath, [QUERY, '--json'], { cwd: warmRepo, timeoutMs: 10 * 60_000 });
    if (build.exitCode !== 0)
      fail(`Could not build the warm reference index: ${build.stderr || build.stdout}`);
  }

  if (only('freshProcessCurrentIndex')) {
    const warmupRuns = 5;
    for (let i = 0; i < warmupRuns; i++)
      runOnce(cliPath, [QUERY, '--json', '--no-refresh'], { cwd: warmRepo });
    const sampleCount = 30;
    const samples = [];
    for (let i = 0; i < sampleCount; i++) {
      const r = runOnce(cliPath, [QUERY, '--json', '--no-refresh'], { cwd: warmRepo });
      if (r.exitCode === 0) samples.push(r.elapsedMs);
    }
    results.workloads.freshProcessCurrentIndex = {
      warmupRuns,
      requestedSamples: sampleCount,
      successfulSamples: samples.length,
      latencyMs: summarizeLatencies(samples),
      targetNote:
        'Section 24 initial target: warm-cache fresh-process CLI p95 under 1s on the reference corpus. This is a target, not an established result.',
    };
  }

  if (only('loadedProcessQueryLoop')) {
    const sampleCount = 30;
    const samples = [];
    for (let i = 0; i < sampleCount; i++) {
      const r = runOnce(cliPath, [QUERY, '--json', '--no-refresh'], { cwd: warmRepo });
      if (r.exitCode === 0) samples.push(r.elapsedMs);
    }
    results.workloads.loadedProcessQueryLoop = {
      label:
        'DIAGNOSTIC ONLY -- approximated via back-to-back fresh processes, NOT a true in-process query loop.',
      latencyMs: summarizeLatencies(samples),
    };
  }

  // ---- 5: one new ordinary commit ----------------------------------------
  if (only('oneNewCommit')) {
    const before = statusJson(cliPath, warmRepo).json;
    writeRepoFile(warmRepo, 'PERF_NOTES.md', `perf note ${Date.now()}\n`);
    commitAll(warmRepo, {
      message: 'perf: add one ordinary commit',
      epochSeconds: Math.floor(Date.now() / 1000),
    });
    const queryAfterCommit = runOnce(cliPath, [QUERY, '--json'], {
      cwd: warmRepo,
      timeoutMs: 60_000,
    });
    const after = statusJson(cliPath, warmRepo).json;
    results.workloads.oneNewCommit = {
      totalMs: queryAfterCommit.elapsedMs,
      indexedCommitsBefore: before?.index?.indexedCommits ?? null,
      indexedCommitsAfter: after?.index?.indexedCommits ?? null,
      targetNote:
        'Section 24 initial target: one small incremental commit plus query within 3s on reference hardware.',
    };
  }

  // ---- 6: ten new commits, batch throughput + peak memory ----------------
  if (only('tenNewCommits')) {
    for (let i = 0; i < 10; i++) {
      writeRepoFile(warmRepo, `perf-batch-${i}.md`, `batch commit ${i}\n`);
      commitAll(warmRepo, {
        message: `perf: batch commit ${i}`,
        epochSeconds: Math.floor(Date.now() / 1000) + i,
      });
    }
    const sampled = await runAsyncWithMemorySampling(cliPath, [QUERY, '--json'], { cwd: warmRepo });
    results.workloads.tenNewCommits = {
      totalMs: sampled.elapsedMs,
      exitCode: sampled.exitCode,
      peakRssKb: sampled.peakRssKb,
      rssSampleCount: sampled.rssSampleCount,
      throughputCommitsPerSec: sampled.exitCode === 0 ? 10 / (sampled.elapsedMs / 1000) : null,
    };
  }

  // ---- 7: unchanged refs -> no re-embedding --------------------------------
  if (only('unchangedRefs')) {
    const first = statusJson(cliPath, warmRepo).json;
    const r = runOnce(cliPath, [QUERY, '--json'], { cwd: warmRepo });
    const second = statusJson(cliPath, warmRepo).json;
    results.workloads.unchangedRefs = {
      queryTotalMs: r.elapsedMs,
      indexedAtBefore: first?.index?.indexedAt ?? null,
      indexedAtAfter: second?.index?.indexedAt ?? null,
      noReembeddingInferred:
        first?.index?.indexedAt != null && first.index.indexedAt === second?.index?.indexedAt,
      note: 'indexedAt unchanged is used as the externally-observable proxy for "no document re-embedding"; query embedding of the incoming query text may still occur per spec.',
    };
  }

  // ---- 8: rename / rebase / branch deletion -------------------------------
  if (only('renameRebaseBranchDeletion')) {
    const scenarioRepo = cloneFixtureForPerf(baseFixtureDir, PERF_WORK_DIR, 'rename-rebase-branch');
    rmSync(join(scenarioRepo, '.git', 'why'), { recursive: true, force: true });
    const buildIdx = runOnce(cliPath, [QUERY, '--json'], {
      cwd: scenarioRepo,
      timeoutMs: 10 * 60_000,
    });
    const before = statusJson(cliPath, scenarioRepo).json;

    git(scenarioRepo, ['checkout', '-b', 'perf-scratch']);
    writeRepoFile(scenarioRepo, 'renamed-perf-file.md', 'renamed content\n');
    commitAll(scenarioRepo, {
      message: 'perf: add file to rename',
      epochSeconds: Math.floor(Date.now() / 1000),
    });
    git(scenarioRepo, ['mv', 'renamed-perf-file.md', 'renamed-perf-file-v2.md']);
    commitAll(scenarioRepo, {
      message: 'perf: rename file',
      epochSeconds: Math.floor(Date.now() / 1000) + 1,
    });
    const afterRename = runOnce(cliPath, [QUERY, '--json'], {
      cwd: scenarioRepo,
      timeoutMs: 60_000,
    });

    git(scenarioRepo, ['checkout', 'main']);
    git(scenarioRepo, ['branch', '-D', 'perf-scratch']);
    const afterBranchDelete = runOnce(cliPath, [QUERY, '--json'], {
      cwd: scenarioRepo,
      timeoutMs: 60_000,
    });
    const afterAll = statusJson(cliPath, scenarioRepo).json;

    results.workloads.renameRebaseBranchDeletion = {
      buildMs: buildIdx.elapsedMs,
      recordCountBefore: before?.index?.recordCount ?? null,
      renameQueryMs: afterRename.elapsedMs,
      branchDeleteQueryMs: afterBranchDelete.elapsedMs,
      recordCountAfter: afterAll?.index?.recordCount ?? null,
      note: 'A full rebase scenario is not exercised here (the fixture generator does not produce a rebase-able branch); this covers rename + branch deletion only. See bench/README.md limitations.',
    };
  }

  // ---- 9: concurrent readers 2/4/8 ----------------------------------------
  if (only('concurrentReaders')) {
    results.workloads.concurrentReaders = {};
    for (const n of [2, 4, 8]) {
      const runs = await Promise.all(
        Array.from({ length: n }, () =>
          runAsyncWithMemorySampling(cliPath, [QUERY, '--json', '--no-refresh'], { cwd: warmRepo }),
        ),
      );
      const latencies = runs.map((r) => r.elapsedMs);
      const failures = runs.filter((r) => r.exitCode !== 0).length;
      const peakRss = runs.map((r) => r.peakRssKb).filter((x) => x !== null);
      results.workloads.concurrentReaders[`n${n}`] = {
        latencyMs: summarizeLatencies(latencies),
        failures,
        aggregatePeakRssKb: peakRss.length ? Math.max(...peakRss) : null,
        note: "aggregatePeakRssKb samples each reader's own process tree independently; true simultaneous aggregate memory would require one shared sampler across all N processes at once, which this per-reader sampler approximates by taking the max of per-reader peaks (a lower bound on true simultaneous aggregate RSS).",
      };
    }
  }

  // ---- 10: readers + updater ----------------------------------------------
  if (only('readersPlusUpdater')) {
    const updaterPromise = (async () => {
      writeRepoFile(warmRepo, 'perf-updater-file.md', 'updater content\n');
      commitAll(warmRepo, {
        message: 'perf: updater commit',
        epochSeconds: Math.floor(Date.now() / 1000),
      });
      return runOnce(cliPath, [QUERY, '--json'], { cwd: warmRepo, timeoutMs: 60_000 });
    })();
    const readerPromises = Array.from({ length: 4 }, () =>
      runAsyncWithMemorySampling(cliPath, [QUERY, '--json'], { cwd: warmRepo }),
    );
    const [updaterResult, readerResults] = await Promise.all([
      updaterPromise,
      Promise.all(readerPromises),
    ]);
    const readerFailures = readerResults.filter((r) => r.exitCode !== 0).length;
    const readerParseFailures = readerResults.filter(
      (r) => r.exitCode === 0 && r.json === null,
    ).length;
    results.workloads.readersPlusUpdater = {
      updater: { totalMs: updaterResult.elapsedMs, exitCode: updaterResult.exitCode },
      readers: {
        n: readerResults.length,
        latencyMs: summarizeLatencies(readerResults.map((r) => r.elapsedMs)),
        failures: readerFailures,
        malformedResponses: readerParseFailures,
      },
      finalStatus: statusJson(cliPath, warmRepo).json,
    };
  }

  // ---- 11: two simultaneous first uses ------------------------------------
  if (only('twoSimultaneousFirstUses')) {
    const raceRepoA = cloneFixtureForPerf(baseFixtureDir, PERF_WORK_DIR, 'race-a');
    // Two "readers" pointed at the SAME repo, both racing to build the index
    // for the first time, is the actual scenario (same common dir / same
    // .git/why state dir) -- not two different repos.
    rmSync(join(raceRepoA, '.git', 'why'), { recursive: true, force: true });
    const [first, second] = await Promise.all([
      runAsyncWithMemorySampling(cliPath, [QUERY, '--json'], {
        cwd: raceRepoA,
        timeoutMs: 10 * 60_000,
      }),
      runAsyncWithMemorySampling(cliPath, [QUERY, '--json'], {
        cwd: raceRepoA,
        timeoutMs: 10 * 60_000,
      }),
    ]);
    const finalStatus = statusJson(cliPath, raceRepoA).json;

    // Serial baseline for comparison: a single first-use build's record count.
    const raceRepoSerial = cloneFixtureForPerf(
      baseFixtureDir,
      PERF_WORK_DIR,
      'race-serial-baseline',
    );
    rmSync(join(raceRepoSerial, '.git', 'why'), { recursive: true, force: true });
    runOnce(cliPath, [QUERY, '--json'], { cwd: raceRepoSerial, timeoutMs: 10 * 60_000 });
    const serialStatus = statusJson(cliPath, raceRepoSerial).json;

    results.workloads.twoSimultaneousFirstUses = {
      first: { totalMs: first.elapsedMs, exitCode: first.exitCode },
      second: { totalMs: second.elapsedMs, exitCode: second.exitCode },
      bothSucceeded: first.exitCode === 0 && second.exitCode === 0,
      oneWaitedForOther: Math.abs(first.elapsedMs - second.elapsedMs) > 500,
      finalRecordCount: finalStatus?.index?.recordCount ?? null,
      serialBaselineRecordCount: serialStatus?.index?.recordCount ?? null,
      recordCountMatchesSerialBaseline:
        finalStatus?.index?.recordCount != null &&
        finalStatus.index.recordCount === serialStatus?.index?.recordCount,
      coherenceNote:
        "A coherent single index implies the raced final record count equals a normal serial first-use build's record count (no duplicate-record inflation).",
    };
  }

  writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`\n[bench/perf] wrote results to ${join(outDir, 'results.json')}`);
  console.log(
    JSON.stringify(
      { knownGaps: results.knownGaps, workloadsRun: Object.keys(results.workloads) },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
