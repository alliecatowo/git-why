#!/usr/bin/env node
// Benchmark A: historical retrieval. Drives the ONLY documented external
// surface -- `git-why`'s CLI with --json -- against the fixture corpora and
// the labeled dataset in bench/dataset/. Never imports src/*.
//
// Usage:
//   node bench/retrieval/run.mjs --split=dev [--candidates=bench/retrieval/candidates.json]
//   node bench/retrieval/run.mjs --split=test --i-accept-this-is-the-frozen-holdout
//   node bench/retrieval/run.mjs --split=dev --ablation   # summary-only vs summary+evidence probe
//
// Fails loudly (nonzero exit, no results written) if dist/cli/main.js is
// missing, rather than emitting placeholder numbers -- the product is being
// built by other lanes in parallel and may not exist yet.

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { scoreCase, aggregate } from './metrics.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const RESULTS_DIR = join(REPO_ROOT, 'bench', 'results', 'retrieval');
const FIXTURES_DIR = join(REPO_ROOT, 'bench', 'fixtures');
const WORK_FIXTURES_DIR = join(REPO_ROOT, 'bench', 'work', 'fixtures');

function parseArgs(argv) {
  const args = {
    split: 'dev',
    candidates: join(HERE, 'candidates.json'),
    ablation: false,
    acceptFrozenHoldout: false,
  };
  for (const a of argv) {
    if (a.startsWith('--split=')) args.split = a.slice('--split='.length);
    else if (a.startsWith('--candidates='))
      args.candidates = resolve(a.slice('--candidates='.length));
    else if (a === '--ablation') args.ablation = true;
    else if (a === '--i-accept-this-is-the-frozen-holdout') args.acceptFrozenHoldout = true;
  }
  return args;
}

function fail(message) {
  console.error(`\n[bench/retrieval] FAILED: ${message}\n`);
  process.exit(1);
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function resolveCliPath(candidate) {
  const p = resolve(REPO_ROOT, candidate.cliPath);
  if (!existsSync(p)) {
    fail(
      `Candidate "${candidate.label}" points at ${p}, which does not exist.\n` +
        `Build the product first: run \`npm run build\` (or \`mise run build\`) from the repo root.\n` +
        `The evaluation lane (bench/) does not build src/ -- it only drives the built CLI.`,
    );
  }
  return p;
}

function ensureFixture(fixtureId) {
  const manifestPath = join(FIXTURES_DIR, 'manifests', `${fixtureId}.json`);
  if (!existsSync(manifestPath)) {
    fail(
      `No manifest for fixture "${fixtureId}" at ${manifestPath}. Fixture specs are missing or renamed.`,
    );
  }
  const manifest = loadJson(manifestPath);
  const repoDir = join(WORK_FIXTURES_DIR, fixtureId);
  const headFile = spawnSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const currentHead = headFile.status === 0 ? headFile.stdout.trim() : null;
  if (currentHead !== manifest.headSha) {
    console.log(`[bench/retrieval] (re)generating fixture "${fixtureId}"...`);
    const gen = spawnSync('node', [join(FIXTURES_DIR, 'generate.mjs'), `--only=${fixtureId}`], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
    if (gen.status !== 0) fail(`Fixture generation failed for "${fixtureId}".`);
    const recheck = spawnSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).stdout.trim();
    if (recheck !== manifest.headSha) {
      fail(
        `Fixture "${fixtureId}" regenerated to HEAD ${recheck}, expected ${manifest.headSha}. ` +
          `The generator is no longer deterministic, or the manifest is stale -- do not trust results until this is fixed.`,
      );
    }
  }
  return repoDir;
}

function buildArgs({ query, mode, filter, limit }) {
  const args = [query, '-n', String(limit)];
  if (mode === 'text') args.push('--text');
  else if (mode === 'semantic') args.push('--semantic');
  // hybrid: no flag
  args.push('--json');
  if (filter?.after) args.push(`--after=${filter.after}`);
  if (filter?.before) args.push(`--before=${filter.before}`);
  if (filter?.author) args.push(`--author=${filter.author}`);
  if (filter?.paths?.length) {
    args.push('--');
    for (const p of filter.paths) args.push(p.kind === 'directory' ? `${p.value}/` : p.value);
  }
  return args;
}

function runCli(cliPath, args, cwd, env) {
  const start = process.hrtime.bigint();
  const res = spawnSync('node', [cliPath, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  return { ...res, elapsedMs };
}

function primeIndex(cliPath, repoDir, env) {
  // First call with no --no-refresh builds/reconciles the index (hybrid,
  // per spec section 5). All subsequent per-case calls use --no-refresh so
  // we measure retrieval, not repeated indexing, and so an unchanged-refs
  // index is never silently re-embedded mid-benchmark.
  const res = runCli(cliPath, ['warm up the index', '-n', '1', '--json'], repoDir, env);
  if (res.status !== 0) {
    fail(
      `Priming index at ${repoDir} failed (exit ${res.status}).\nstdout: ${res.stdout}\nstderr: ${res.stderr}`,
    );
  }
  return res.elapsedMs;
}

function parseSearchResponse(stdout, context) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    return { ok: false, error: `invalid JSON from CLI (${context}): ${err.message}`, raw: stdout };
  }
  if (!Array.isArray(parsed.results)) {
    return { ok: false, error: `--json output missing "results" array (${context})`, raw: stdout };
  }
  return { ok: true, response: parsed };
}

// The summaries-only ablation is driven by GIT_WHY_BENCH_RECORD_TYPES, an
// evaluation-only environment variable documented in src/search/search.ts
// (`benchRecordTypes()`), NOT a CLI flag. Setting it to "commit" restricts
// retrieval to commit-summary records while leaving the index (which still
// contains evidence records) untouched -- so priming/build only needs to
// happen once per fixture, unaffected by the env var.
const ABLATION_ARMS = [
  { name: 'summary+evidence', env: {} },
  { name: 'summary-only', env: { GIT_WHY_BENCH_RECORD_TYPES: 'commit' } },
];

function runOneQuery(cliPath, repoDir, mode, testCase, env, limit, split) {
  const cliArgs = buildArgs({ query: testCase.query, mode, filter: testCase.filter, limit });
  cliArgs.push('--no-refresh');
  const res = runCli(cliPath, cliArgs, repoDir, env);

  const record = {
    mode,
    caseId: testCase.id,
    category: testCase.category,
    fixtureId: testCase.fixtureId,
    split,
    query: testCase.query,
    relevantShas: testCase.relevantShas,
    elapsedMs: res.elapsedMs,
    exitCode: res.status,
  };

  if (res.status !== 0) {
    record.error = `CLI exited ${res.status}`;
    record.stderr = res.stderr;
    record.omitted = true;
    return record;
  }
  const parsed = parseSearchResponse(res.stdout, `${mode}/${testCase.id}`);
  if (!parsed.ok) {
    record.error = parsed.error;
    record.omitted = true;
    return record;
  }
  const rankedShas = parsed.response.results.map((r) => r.sha);
  record.rankedShas = rankedShas;
  record.candidateCount = parsed.response.results.length;
  record.candidateLimitReached = parsed.response.candidateLimitReached;
  record.warnings = parsed.response.warnings;
  record.snapshotFreshness = parsed.response.snapshot?.freshness ?? null;
  const scored = scoreCase(rankedShas, testCase.relevantShas);
  record.scored = scored;
  if (!scored.applicable) {
    record.noEvidenceObservation = {
      returnedTopK: rankedShas,
      anyResultsReturned: rankedShas.length > 0,
    };
  }
  return record;
}

function diffMetrics(a, b) {
  // a - b, null-safe (null when either side has no applicable cases).
  const keys = ['hit1', 'hit3', 'hit5', 'recall5', 'mrr'];
  const out = {};
  for (const k of keys) {
    out[k] = a?.[k] != null && b?.[k] != null ? a[k] - b[k] : null;
  }
  return out;
}

function runAblation({
  candidate,
  cliPath,
  fixtureDirs,
  fixtureIds,
  dataset,
  modes,
  limit,
  split,
  outDir,
}) {
  for (const fixtureId of fixtureIds) {
    const repoDir = fixtureDirs[fixtureId];
    const primeMs = primeIndex(cliPath, repoDir, candidate.env);
    console.log(
      `[bench/retrieval] ablation: primed "${fixtureId}" for candidate "${candidate.label}" in ${primeMs.toFixed(0)}ms ` +
        '(index contains both record types; the env var only restricts retrieval, not ingestion).',
    );
  }

  const perQuery = [];
  const scoredByArmModeCategory = {};
  for (const arm of ABLATION_ARMS) {
    for (const mode of modes) {
      for (const testCase of dataset.cases) {
        const repoDir = fixtureDirs[testCase.fixtureId];
        const mergedEnv = { ...candidate.env, ...arm.env };
        const record = runOneQuery(cliPath, repoDir, mode, testCase, mergedEnv, limit, split);
        record.candidate = candidate.label;
        record.arm = arm.name;
        perQuery.push(record);
        const key = `${arm.name}::${mode}::${testCase.category}`;
        (scoredByArmModeCategory[key] ??= []).push(record.scored ?? { applicable: false });
      }
    }
  }

  const byArmModeCategory = Object.entries(scoredByArmModeCategory).map(([key, scoredList]) => {
    const [arm, mode, category] = key.split('::');
    return { arm, mode, category, ...aggregate(scoredList) };
  });

  // Overall rows (excluding exact_identifier and no_evidence, per protocol) per arm/mode.
  const overallByArmMode = {};
  for (const rec of perQuery) {
    if (rec.category === 'exact_identifier' || rec.category === 'no_evidence') continue;
    if (!rec.scored) continue;
    const key = `${rec.arm}::${rec.mode}`;
    (overallByArmMode[key] ??= []).push(rec.scored);
  }
  const overallRows = Object.entries(overallByArmMode).map(([key, scoredList]) => {
    const [arm, mode] = key.split('::');
    return {
      arm,
      mode,
      category: 'OVERALL_excl_exact_identifier_and_no_evidence',
      ...aggregate(scoredList),
    };
  });

  // Diff table: summary+evidence minus summary-only, per mode+category and per mode overall.
  const byModeCategory = {};
  for (const row of byArmModeCategory) {
    const key = `${row.mode}::${row.category}`;
    (byModeCategory[key] ??= {})[row.arm] = row;
  }
  const diffByModeCategory = Object.entries(byModeCategory).map(([key, arms]) => {
    const [mode, category] = key.split('::');
    return {
      mode,
      category,
      nSummaryEvidence: arms['summary+evidence']?.n ?? 0,
      nSummaryOnly: arms['summary-only']?.n ?? 0,
      diff_evidenceMinusSummaryOnly: diffMetrics(arms['summary+evidence'], arms['summary-only']),
    };
  });
  const overallByMode = {};
  for (const row of overallRows) {
    (overallByMode[row.mode] ??= {})[row.arm] = row;
  }
  const diffOverall = Object.entries(overallByMode).map(([mode, arms]) => ({
    mode,
    nSummaryEvidence: arms['summary+evidence']?.n ?? 0,
    nSummaryOnly: arms['summary-only']?.n ?? 0,
    diff_evidenceMinusSummaryOnly: diffMetrics(arms['summary+evidence'], arms['summary-only']),
  }));

  const omittedCount = perQuery.filter((r) => r.omitted).length;
  const summary = {
    status: 'ran',
    candidate: candidate.label,
    split,
    mechanism:
      'GIT_WHY_BENCH_RECORD_TYPES=commit restricts retrieval to commit-summary records; unset retrieves ' +
      'commit + evidence records. Index built once per fixture (both record types always ingested); the ' +
      'env var only changes what a query is allowed to retrieve. See src/search/search.ts benchRecordTypes().',
    totalQueries: perQuery.length,
    omittedCount,
    byArmModeCategory,
    overallByArmMode: overallRows,
    diffByModeCategory,
    diffOverall,
  };

  writeFileSync(
    join(outDir, `ablation-per-query-${candidate.label}.json`),
    JSON.stringify(perQuery, null, 2),
  );
  writeFileSync(
    join(outDir, `ablation-summary-${candidate.label}.json`),
    JSON.stringify(summary, null, 2),
  );
  console.log(
    `[bench/retrieval] ablation complete for "${candidate.label}": ${join(outDir, `ablation-summary-${candidate.label}.json`)}`,
  );
  console.table(
    diffOverall.map((r) => ({
      mode: r.mode,
      nEvidence: r.nSummaryEvidence,
      nSummaryOnly: r.nSummaryOnly,
      dHit1: r.diff_evidenceMinusSummaryOnly.hit1,
      dHit3: r.diff_evidenceMinusSummaryOnly.hit3,
      dHit5: r.diff_evidenceMinusSummaryOnly.hit5,
      dRecall5: r.diff_evidenceMinusSummaryOnly.recall5,
      dMRR: r.diff_evidenceMinusSummaryOnly.mrr,
    })),
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.split === 'test' && !args.acceptFrozenHoldout) {
    fail(
      'Refusing to run against the frozen held-out split without --i-accept-this-is-the-frozen-holdout.\n' +
        'This is a tripwire, not a security boundary: its only job is to make sure nobody runs the holdout\n' +
        'by muscle memory while still tuning. Once you pass the flag, this run and its results are final for\n' +
        'this protocol version -- see bench/protocol.json.',
    );
  }
  if (args.split !== 'dev' && args.split !== 'test')
    fail(`--split must be "dev" or "test", got "${args.split}"`);
  if (args.ablation && args.split !== 'dev') {
    fail(
      'The summaries-only ablation is scoped to the development split only, per bench/protocol.json ' +
        '("ablation.scope": "development split only ... never run against the held-out split"). ' +
        `Refusing to run --ablation with --split=${args.split}.`,
    );
  }

  const protocol = loadJson(join(REPO_ROOT, 'bench', 'protocol.json'));
  const candidatesConfig = loadJson(args.candidates);
  const dataset = loadJson(join(REPO_ROOT, 'bench', 'dataset', `${args.split}.json`));

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(RESULTS_DIR, `${args.split}-${runId}`);
  mkdirSync(outDir, { recursive: true });

  const fixtureIds = [...new Set(dataset.cases.map((c) => c.fixtureId))];
  const fixtureDirs = Object.fromEntries(fixtureIds.map((id) => [id, ensureFixture(id)]));

  const limit = protocol.candidateLimits.resultLimitForMetrics;
  const modes = ['text', 'semantic', 'hybrid'];
  const perQueryRecords = [];
  const summaryByCandidateModeCategory = {};

  for (const candidate of candidatesConfig.candidates) {
    const cliPath = resolveCliPath(candidate);

    if (args.ablation) {
      runAblation({
        candidate,
        cliPath,
        fixtureDirs,
        fixtureIds,
        dataset,
        modes,
        limit,
        split: args.split,
        outDir,
      });
      continue;
    }

    for (const fixtureId of fixtureIds) {
      const repoDir = fixtureDirs[fixtureId];
      const primeMs = primeIndex(cliPath, repoDir, candidate.env);
      console.log(
        `[bench/retrieval] primed "${fixtureId}" for candidate "${candidate.label}" in ${primeMs.toFixed(0)}ms`,
      );
    }

    for (const mode of modes) {
      for (const testCase of dataset.cases) {
        const repoDir = fixtureDirs[testCase.fixtureId];
        const cliArgs = buildArgs({ query: testCase.query, mode, filter: testCase.filter, limit });
        cliArgs.push('--no-refresh');
        const res = runCli(cliPath, cliArgs, repoDir, candidate.env);

        const record = {
          candidate: candidate.label,
          mode,
          caseId: testCase.id,
          category: testCase.category,
          fixtureId: testCase.fixtureId,
          split: args.split,
          query: testCase.query,
          relevantShas: testCase.relevantShas,
          elapsedMs: res.elapsedMs,
          exitCode: res.status,
        };

        if (res.status !== 0) {
          record.error = `CLI exited ${res.status}`;
          record.stderr = res.stderr;
          record.omitted = true;
        } else {
          const parsed = parseSearchResponse(
            res.stdout,
            `${candidate.label}/${mode}/${testCase.id}`,
          );
          if (!parsed.ok) {
            record.error = parsed.error;
            record.omitted = true;
          } else {
            const rankedShas = parsed.response.results.map((r) => r.sha);
            record.rankedShas = rankedShas;
            record.candidateCount = parsed.response.results.length;
            record.candidateLimitReached = parsed.response.candidateLimitReached;
            record.warnings = parsed.response.warnings;
            record.snapshotFreshness = parsed.response.snapshot?.freshness ?? null;
            const scored = scoreCase(rankedShas, testCase.relevantShas);
            record.scored = scored;
            if (!scored.applicable) {
              // no-evidence: report what came back instead of a metric.
              record.noEvidenceObservation = {
                returnedTopK: rankedShas,
                anyResultsReturned: rankedShas.length > 0,
              };
            }
          }
        }

        perQueryRecords.push(record);

        const key = `${candidate.label}::${mode}::${testCase.category}`;
        (summaryByCandidateModeCategory[key] ??= []).push(record.scored ?? { applicable: false });
      }
    }
  }

  writeFileSync(join(outDir, 'per-query.json'), JSON.stringify(perQueryRecords, null, 2));

  const summaryRows = [];
  for (const [key, scoredList] of Object.entries(summaryByCandidateModeCategory)) {
    const [candidateLabel, mode, category] = key.split('::');
    summaryRows.push({ candidate: candidateLabel, mode, category, ...aggregate(scoredList) });
  }
  // Also an overall (all categories except exact_identifier and no_evidence combined) row per candidate/mode,
  // per protocol: exact-identifier reported separately, no-evidence excluded from Hit/Recall/MRR entirely.
  const overallByKey = {};
  for (const rec of perQueryRecords) {
    if (rec.category === 'exact_identifier' || rec.category === 'no_evidence') continue;
    if (!rec.scored) continue;
    const key = `${rec.candidate}::${rec.mode}`;
    (overallByKey[key] ??= []).push(rec.scored);
  }
  const overallRows = Object.entries(overallByKey).map(([key, scoredList]) => {
    const [candidate, mode] = key.split('::');
    return {
      candidate,
      mode,
      category: 'OVERALL_excl_exact_identifier_and_no_evidence',
      ...aggregate(scoredList),
    };
  });

  const omittedCount = perQueryRecords.filter((r) => r.omitted).length;
  const noEvidenceRecords = perQueryRecords.filter((r) => r.category === 'no_evidence');

  const summary = {
    runId,
    split: args.split,
    protocolHash: protocol.protocolHash,
    generatedAt: new Date().toISOString(),
    totalQueries: perQueryRecords.length,
    omittedCount,
    byCandidateModeCategory: summaryRows,
    overall: overallRows,
    noEvidenceObservations: noEvidenceRecords.map((r) => ({
      caseId: r.caseId,
      candidate: r.candidate,
      mode: r.mode,
      returnedTopK: r.noEvidenceObservation?.returnedTopK ?? null,
      omitted: !!r.omitted,
    })),
  };
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));

  console.log(
    `\n[bench/retrieval] wrote ${perQueryRecords.length} query records and summary to ${outDir}`,
  );
  if (omittedCount > 0) {
    console.warn(
      `[bench/retrieval] WARNING: ${omittedCount} queries were omitted due to CLI errors -- see per-query.json`,
    );
  }
  console.table(
    summaryRows.map((r) => ({
      candidate: r.candidate,
      mode: r.mode,
      category: r.category,
      n: r.n,
      hit5: r.hit5,
      recall5: r.recall5,
      mrr: r.mrr,
    })),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
