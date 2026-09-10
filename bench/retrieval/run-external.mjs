#!/usr/bin/env node
/**
 * External-validity check: runs the hand-authored cases in
 * bench/dataset/external*.json against real, pinned public repositories.
 *
 * docs/spec.md section 18 asks for at least 12 manually inspected questions
 * over at least two public histories, with repository URL, license, cutoff SHA
 * and relevant SHAs pinned before the scorer runs. Authoring those cases is not
 * the same as executing them: without this runner the dataset is labelled
 * material, not measured evidence, and the report may not claim
 * real-repository validation.
 *
 * Usage:
 *   node bench/retrieval/run-external.mjs --repos=<dir> [options]
 *
 * Options:
 *   --dataset=<path>   Dataset JSON to run (default: bench/dataset/external.json,
 *                       so existing external.json results stay reproducible without
 *                       passing anything new). Pass --dataset=bench/dataset/external-v2.json
 *                       to run the larger external-validity suite.
 *   --modes=<list>     Comma-separated subset of text,semantic,hybrid (default: hybrid).
 *   --ablation         Also run the summary-only vs summary+evidence retrieval arms
 *                       (GIT_WHY_BENCH_RECORD_TYPES, see src/search/search.ts
 *                       benchRecordTypes()) and report the diff. Index is built once;
 *                       the env var only restricts what a query may retrieve.
 *   --scale=<path>     Optional JSON file: { [repositoryId]: { indexSeconds, notes } }.
 *                       Commit/record/disk-byte counts are always read live (read-only,
 *                       via `git why status --json`) from each pinned clone; this file
 *                       only supplies wall-clock indexing time, which the runner itself
 *                       does not measure because indexes are expected to be prebuilt.
 *
 * <dir> must hold one clone per repository id, each checked out at its pinned
 * cutoff SHA with no post-cutoff objects reachable.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreCase, aggregate } from './metrics.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CLI = path.join(ROOT, 'dist', 'cli', 'main.js');

function parseArgs(argv) {
  const out = {
    repos: null,
    dataset: null,
    modes: 'hybrid',
    ablation: false,
    scale: null,
    split: null,
  };
  for (const a of argv) {
    const [kRaw, ...vRest] = a.replace(/^--/, '').split('=');
    const v = vRest.join('=');
    if (kRaw === 'repos') out.repos = v;
    else if (kRaw === 'dataset') out.dataset = v;
    else if (kRaw === 'modes') out.modes = v;
    else if (kRaw === 'ablation') out.ablation = true;
    else if (kRaw === 'scale') out.scale = v;
    // Restricts scoring to one split. Without it a "measure dev" run silently
    // executes the held-out cases too, which is how a holdout stops being one.
    else if (kRaw === 'split') out.split = v;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.repos) {
  console.error(
    'usage: node bench/retrieval/run-external.mjs --repos=<dir> ' +
      '[--dataset=bench/dataset/external.json] [--modes=text,semantic,hybrid] [--ablation] [--scale=<path>]',
  );
  process.exit(2);
}

const datasetPath = args.dataset
  ? path.resolve(ROOT, args.dataset)
  : path.join(ROOT, 'bench', 'dataset', 'external.json');
const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
const modes = args.modes
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
for (const m of modes) {
  if (!['text', 'semantic', 'hybrid'].includes(m)) {
    console.error(`unknown mode "${m}"; must be one of text,semantic,hybrid`);
    process.exit(2);
  }
}
const scaleOverrides = args.scale
  ? JSON.parse(fs.readFileSync(path.resolve(ROOT, args.scale), 'utf8'))
  : {};

/**
 * Resolves a repository's clone directory.
 *
 * Two naming schemes are in play: clones created by the maintenance scripts
 * use the dataset's full `id` (`curl-curl`), while the original hand-made
 * bundles used `<last-segment>-cut` (`curl-cut`). Trying the id first and
 * falling back keeps both working, rather than silently skipping every
 * repository because the convention drifted -- which is exactly what happened,
 * and produced a run that scored zero rows and still exited 0.
 */
function resolveRepoDir(id) {
  const root = String(args.repos);
  const candidates = [path.join(root, id), path.join(root, `${id.split('-').pop()}-cut`)];
  return candidates.find((dir) => fs.existsSync(path.join(dir, '.git'))) ?? candidates[0];
}

const dirFor = new Map(dataset.repositories.map((r) => [r.id, resolveRepoDir(r.id)]));

/** Refuse to score against a working copy that can see past the cutoff. */
function assertCutoff(repoDir, cutoffSha) {
  const head = execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  if (head !== cutoffSha)
    throw new Error(`${repoDir}: HEAD ${head} is not the pinned cutoff ${cutoffSha}`);
}

/** Read-only: reports index state, never mutates (no --no-refresh needed for `status`). */
function readIndexScale(repoDir) {
  try {
    const out = execFileSync(process.execPath, [CLI, 'status', '--json'], {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed = JSON.parse(out);
    return {
      indexedCommits: parsed.index?.indexedCommits ?? null,
      recordCount: parsed.index?.recordCount ?? null,
      diskBytes: parsed.index?.diskBytes ?? null,
      state: parsed.index?.state ?? null,
    };
  } catch (err) {
    return { error: `status failed: ${err.message}` };
  }
}

function buildCliArgs({ query, mode, limit }) {
  const cliArgs = [query, '-n', String(limit)];
  if (mode === 'text') cliArgs.push('--text');
  else if (mode === 'semantic') cliArgs.push('--semantic');
  cliArgs.push('--json', '--no-refresh');
  return cliArgs;
}

// Same mechanism as bench/retrieval/run.mjs's ablation: GIT_WHY_BENCH_RECORD_TYPES
// restricts retrieval to commit-summary records when set to "commit"; unset (default
// arm) retrieves commit + evidence records. The index (built ahead of time, outside
// this script, with --no-refresh required at query time) always contains both record
// types -- this env var only changes what a query is allowed to retrieve.
const ARMS = args.ablation
  ? [
      { name: 'summary+evidence', env: {} },
      { name: 'summary-only', env: { GIT_WHY_BENCH_RECORD_TYPES: 'commit' } },
    ]
  : [{ name: 'summary+evidence', env: {} }];

function runOneQuery(dir, mode, arm, c, limit) {
  const started = Date.now();
  let ranked = [];
  let exitCode = 0;
  let stderr = '';
  try {
    const out = execFileSync(
      process.execPath,
      [CLI, ...buildCliArgs({ query: c.query, mode, limit })],
      {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, ...arm.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    ranked = JSON.parse(out).results.map((r) => r.sha);
  } catch (err) {
    exitCode = err.status ?? 1;
    stderr = err.stderr ? String(err.stderr).slice(0, 2000) : String(err.message ?? err);
  }
  const scored = scoreCase(ranked, c.relevantShas ?? []);
  return {
    id: c.id,
    repositoryId: c.repositoryId,
    split: c.split,
    category: c.category,
    mode,
    arm: arm.name,
    query: c.query,
    relevantShas: [...(c.relevantShas ?? [])],
    rankedShas: ranked,
    exitCode,
    stderr: exitCode === 0 ? undefined : stderr,
    elapsedMs: Date.now() - started,
    scored,
    // Kept for backward compatibility with the original single-mode/single-arm shape.
    hit1: scored.hit1,
    hit3: scored.hit3,
    hit5: scored.hit5,
    reciprocalRank: scored.mrr,
    noEvidenceObservation: scored.applicable
      ? undefined
      : { returnedTopK: ranked, anyResultsReturned: ranked.length > 0 },
  };
}

const rows = [];
const repoScale = {};
for (const repo of dataset.repositories) {
  const dir = dirFor.get(repo.id);
  if (!fs.existsSync(dir)) {
    console.error(`[skip] ${repo.id}: no clone at ${dir}`);
    continue;
  }
  assertCutoff(dir, repo.cutoffSha);
  repoScale[repo.id] = {
    ...readIndexScale(dir),
    ...(scaleOverrides[repo.id] ?? {}),
  };

  const casesForRepo = dataset.cases.filter(
    (x) => x.repositoryId === repo.id && (args.split === null || x.split === args.split),
  );
  for (const mode of modes) {
    for (const arm of ARMS) {
      for (const c of casesForRepo) {
        rows.push(runOneQuery(dir, mode, arm, c, 5));
      }
    }
  }
}

function summarize(rowSubset) {
  const scored = rowSubset.map((r) => r.scored);
  return aggregate(scored);
}

// Overall, per mode, default arm only (the headline numbers).
const defaultArmRows = rows.filter((r) => r.arm === 'summary+evidence');
const overallByMode = modes.map((mode) => ({
  mode,
  ...summarize(defaultArmRows.filter((r) => r.mode === mode)),
}));

const bySplit = ['dev', 'test'].flatMap((split) =>
  modes.map((mode) => ({
    split,
    mode,
    ...summarize(defaultArmRows.filter((r) => r.mode === mode && r.split === split)),
  })),
);

const repositories = dataset.repositories.filter((r) => repoScale[r.id]);
const byRepository = repositories.flatMap((repo) =>
  modes.map((mode) => ({
    repositoryId: repo.id,
    mode,
    scale: repoScale[repo.id],
    ...summarize(defaultArmRows.filter((r) => r.repositoryId === repo.id && r.mode === mode)),
  })),
);

const categories = [...new Set(dataset.cases.map((c) => c.category))];
const byCategory = categories.flatMap((category) =>
  modes.map((mode) => ({
    category,
    mode,
    ...summarize(defaultArmRows.filter((r) => r.category === category && r.mode === mode)),
  })),
);

const noEvidenceRows = defaultArmRows.filter((r) => r.noEvidenceObservation);

let ablation = null;
if (args.ablation) {
  function diffMetrics(a, b) {
    const keys = ['hit1', 'hit3', 'hit5', 'recall5', 'mrr'];
    const out = {};
    for (const k of keys) out[k] = a?.[k] != null && b?.[k] != null ? a[k] - b[k] : null;
    return out;
  }
  const byArmMode = modes.map((mode) => {
    const arms = Object.fromEntries(
      ARMS.map((arm) => [
        arm.name,
        summarize(rows.filter((r) => r.mode === mode && r.arm === arm.name)),
      ]),
    );
    return { mode, ...arms };
  });
  const byArmModeRepository = repositories.flatMap((repo) =>
    modes.map((mode) => {
      const arms = Object.fromEntries(
        ARMS.map((arm) => [
          arm.name,
          summarize(
            rows.filter((r) => r.mode === mode && r.arm === arm.name && r.repositoryId === repo.id),
          ),
        ]),
      );
      return { repositoryId: repo.id, mode, ...arms };
    }),
  );
  ablation = {
    mechanism:
      'GIT_WHY_BENCH_RECORD_TYPES=commit restricts retrieval to commit-summary records; unset ' +
      '(summary+evidence) retrieves commit + evidence records. Index built once per repository ' +
      '(both record types always ingested); the env var only changes what a query is allowed to ' +
      'retrieve at read time. See src/search/search.ts benchRecordTypes().',
    overallByMode: byArmMode.map((row) => ({
      mode: row.mode,
      diff_evidenceMinusSummaryOnly: diffMetrics(row['summary+evidence'], row['summary-only']),
      'summary+evidence': row['summary+evidence'],
      'summary-only': row['summary-only'],
    })),
    byRepositoryMode: byArmModeRepository.map((row) => ({
      repositoryId: row.repositoryId,
      mode: row.mode,
      diff_evidenceMinusSummaryOnly: diffMetrics(row['summary+evidence'], row['summary-only']),
      'summary+evidence': row['summary+evidence'],
      'summary-only': row['summary-only'],
    })),
  };
}

const summary = {
  generatedAt: new Date().toISOString(),
  datasetPath: path.relative(ROOT, datasetPath),
  modes,
  ablationRun: args.ablation,
  repositories: repositories.map((r) => ({
    id: r.id,
    url: r.url,
    license: r.license,
    cutoffSha: r.cutoffSha,
    scale: repoScale[r.id],
  })),
  totalCases: dataset.cases.length,
  answerableCases: dataset.cases.filter((c) => (c.relevantShas ?? []).length > 0).length,
  noEvidenceCases: dataset.cases.filter((c) => (c.relevantShas ?? []).length === 0).length,
  overallByMode,
  bySplit,
  byRepository,
  byCategory,
  noEvidenceObservations: noEvidenceRows.map((r) => ({
    id: r.id,
    repositoryId: r.repositoryId,
    mode: r.mode,
    query: r.query,
    returnedTopK: r.noEvidenceObservation.returnedTopK,
  })),
  ablation,
  notBlinded: dataset.notBlinded,
};

const outDir = path.join(
  ROOT,
  'bench',
  'results',
  path.basename(datasetPath, '.json') === 'external' ? 'external' : 'external-v2',
  new Date().toISOString().replace(/[:.]/g, '-'),
);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'per-query.json'), JSON.stringify(rows, null, 2));
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(
  `[bench/external] dataset=${summary.datasetPath} modes=${modes.join(',')} ablation=${args.ablation}`,
);
console.log(`[bench/external] wrote ${rows.length} rows to ${outDir}`);

// A run that scored nothing is a failure, not a result. Exiting 0 with a table
// of nulls reads as "the benchmark ran" to anyone downstream -- including the
// report generator -- and that is how an absent measurement gets mistaken for
// a measured absence.
if (rows.length === 0) {
  console.error(
    `\n[bench/external] FAILED: scored 0 cases. Every repository was skipped, ` +
      `so no clone was found under ${args.repos}. Check the directory names ` +
      `against the dataset's repository ids, and run ` +
      `\`node bench/verify-external-clones.mjs\` to confirm the clones are ` +
      `present and pinned.`,
  );
  process.exit(1);
}
console.table(
  overallByMode.map((r) => ({
    mode: r.mode,
    n: r.n,
    hit1: r.hit1,
    hit3: r.hit3,
    hit5: r.hit5,
    mrr: r.mrr,
  })),
);
if (ablation) {
  console.table(
    ablation.overallByMode.map((r) => ({
      mode: r.mode,
      dHit1: r.diff_evidenceMinusSummaryOnly.hit1,
      dHit3: r.diff_evidenceMinusSummaryOnly.hit3,
      dHit5: r.diff_evidenceMinusSummaryOnly.hit5,
      dMRR: r.diff_evidenceMinusSummaryOnly.mrr,
    })),
  );
}
