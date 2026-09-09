#!/usr/bin/env node
// Orchestrates Benchmark B (docs/spec.md sections 19-23): the four-arm
// OpenCode usefulness pilot. Builds isolated workspaces per trial, runs
// OpenCode through bench/agents/runner.mjs, grades through
// bench/agents/grade.mjs, and writes the full section-23 field list per
// trial. Concurrency-limited to 2 OpenCode sessions TOTAL, arms randomized
// and interleaved within each task/trial block, per protocol.
//
// Usage:
//   node bench/agents/run.mjs --stage=smoke
//   node bench/agents/run.mjs --stage=pilot
//   node bench/agents/run.mjs --stage=pilot --only=T1,T5
//
// zg (arms B/C) is not installed in this environment. Those trials are
// recorded as infrastructure-blocked, not silently skipped or faked; the
// exact same code path runs for real the moment `zg` appears on PATH.

import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

import { buildIsolatedTrialWorkspace } from './isolation.mjs';
import { createIsolatedProfile, inspectProfile, runTrial } from './runner.mjs';
import { gradeTrial } from './grade.mjs';
import { mulberry32, seedFromString, shuffle } from '../fixtures/lib/rng.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const TASKS_DIR = join(HERE, 'tasks');
const HIDDEN_DIR = join(TASKS_DIR, 'hidden');
const MANIFEST_DIR = join(TASKS_DIR, 'manifests');
const SOURCE_REPOS_DIR = join(REPO_ROOT, 'bench', 'work', 'agents-tasks');
const WORK_ROOT = join(REPO_ROOT, 'bench', 'work', 'agents-runs');
const RESULTS_DIR = join(REPO_ROOT, 'bench', 'results', 'agents');
const USAGE_CARDS_DIR = join(HERE, 'usage-cards');

const ALL_TASK_IDS = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8'];
const SMOKE_TASK_IDS = ['T1', 'T5', 'T6', 'T8']; // one coding, one rubric, one control-with-history-unnecessary, one no-evidence rubric
const ARMS = ['A', 'B', 'C', 'D'];

// Model calibrated by a tiny neutral run during harness development
// (read a file, trivial edit, produce valid output) -- see bench/README.md.
// Re-run calibration before trusting this choice for a real pilot; free
// model availability changes.
const DEFAULT_MODEL = 'opencode/big-pickle';

const BUDGETS = { wallClockMs: 8 * 60_000, toolCalls: 60, generatedTokens: 12_000 };
const TOTAL_CONCURRENCY = 2;

function parseArgs(argv) {
  const args = { stage: 'smoke', only: null, model: DEFAULT_MODEL, repetitions: null };
  for (const a of argv) {
    if (a.startsWith('--stage=')) args.stage = a.slice('--stage='.length);
    else if (a.startsWith('--only=')) args.only = a.slice('--only='.length).split(',');
    else if (a.startsWith('--model=')) args.model = a.slice('--model='.length);
    else if (a.startsWith('--repetitions=')) args.repetitions = Number(a.slice('--repetitions='.length));
  }
  return args;
}

function fail(msg) {
  console.error(`\n[bench/agents] FAILED: ${msg}\n`);
  process.exit(1);
}

export function checkZgAvailable() {
  const res = spawnSync('zg', ['--version'], { encoding: 'utf8' });
  return res.status === 0;
}

function loadTaskMeta(taskId) {
  const manifestPath = join(MANIFEST_DIR, `${taskId}.json`);
  if (!existsSync(manifestPath)) {
    fail(`No manifest for task ${taskId}. Run: node bench/agents/tasks/build.mjs`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const promptPath = join(HIDDEN_DIR, taskId, 'prompt.md');
  const hiddenTestPath = join(HIDDEN_DIR, taskId, 'task.test.cjs');
  const rubricPath = join(HIDDEN_DIR, taskId, 'rubric.json');
  return {
    taskId,
    baseSha: manifest.baseSha,
    goldSha: manifest.goldSha,
    sourceRepoDir: join(SOURCE_REPOS_DIR, taskId),
    promptText: readFileSync(promptPath, 'utf8'),
    hiddenTestPath: existsSync(hiddenTestPath) ? hiddenTestPath : null,
    rubric: existsSync(rubricPath) ? JSON.parse(readFileSync(rubricPath, 'utf8')) : null,
  };
}

function usageCardFor(arm) {
  const gitWhyCard = readFileSync(join(USAGE_CARDS_DIR, 'git-why.md'), 'utf8');
  const zgCard = readFileSync(join(USAGE_CARDS_DIR, 'zg.md'), 'utf8');
  switch (arm) {
    case 'A':
      return null;
    case 'B':
      return zgCard;
    case 'C':
      return `${zgCard}\n\n${gitWhyCard}`;
    case 'D':
      return gitWhyCard;
    default:
      throw new Error(`unknown arm ${arm}`);
  }
}

function armNeedsZg(arm) {
  return arm === 'B' || arm === 'C';
}

/** Build the randomized, interleaved execution plan: within each
 * (task, repetition) block, arm order is shuffled; blocks across different
 * tasks/repetitions are interleaved round-robin so no arm systematically
 * runs first or last, or all at the same time of day. */
function buildPlan({ taskIds, repetitions, seed }) {
  const rng = mulberry32(seedFromString(seed));
  const blocks = [];
  for (const taskId of taskIds) {
    for (let rep = 1; rep <= repetitions; rep++) {
      blocks.push({ taskId, repetition: rep, arms: shuffle(rng, ARMS) });
    }
  }
  const shuffledBlocks = shuffle(rng, blocks);
  const plan = [];
  const maxArms = Math.max(...shuffledBlocks.map((b) => b.arms.length));
  for (let i = 0; i < maxArms; i++) {
    for (const block of shuffledBlocks) {
      if (block.arms[i]) plan.push({ taskId: block.taskId, repetition: block.repetition, arm: block.arms[i] });
    }
  }
  return plan;
}

/** Tiny concurrency pool: runs `items` through `worker`, at most `limit` in flight. */
async function pooledMap(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runNext() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
  return results;
}

function isInfrastructureError(trialResult) {
  // A process-level failure to even reach the model (spawn error, provider
  // outage before any step_finish) is infrastructure; a completed run with
  // a wrong/incomplete answer is a model outcome, not infrastructure.
  return trialResult.exitCode === null && trialResult.eventCount === 0;
}

async function runOnePlannedTrial(planItem, { taskMetaById, model, runRoot, reviewDir, zgAvailable, attempt }) {
  const { taskId, arm, repetition } = planItem;
  const taskMeta = taskMetaById[taskId];
  const trialLabel = `${taskId}-${arm}-r${repetition}-a${attempt}`;

  const record = {
    task_id: taskId,
    task_stratum: taskMeta.rubric ? 'rubric' : 'coding',
    arm,
    repetition,
    base_sha: taskMeta.baseSha,
    corpus_fingerprint: null, // set once git-why/zg indexing is wired up for real trials
    implementation_sha: gitHeadOfThisRepoOrNull(),
    model_id: model,
    provider_id: 'opencode',
    model_metadata_timestamp: new Date().toISOString(),
    opencode_version: opencodeVersion(),
    zg_version: zgAvailable ? zgVersion() : null,
    git_version: gitVersion(),
    runtime_version: process.version,
    profile_hash: null,
    prompt_hash: null,
    protocol_hash: loadProtocolHash(),
    dependency_lock_hash: null,
    pass: null,
    hidden_tests_passed: null,
    hidden_tests_total: null,
    evidence_grade: null,
    wall_ms: null,
    tool_calls: null,
    history_calls: null,
    zg_calls: null,
    git_why_calls: null,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    actual_billed_cost: null,
    estimated_list_price_cost: null,
    tool_output_bytes: null,
    index_build_ms: null,
    model_download_ms: null,
    index_disk_bytes: null,
    exit_reason: null,
    infrastructure_error: null,
    treatment_error: null,
    invalidation_reason: null,
    attempt,
  };

  if (armNeedsZg(arm) && !zgAvailable) {
    record.exit_reason = 'infrastructure_blocked';
    record.infrastructure_error = 'zg not installed on PATH; arm requires zg per protocol. See bench/protocol.json arms.B/C.status.';
    return record;
  }

  let workspace;
  try {
    workspace = buildIsolatedTrialWorkspace({
      sourceRepoDir: taskMeta.sourceRepoDir,
      baseSha: taskMeta.baseSha,
      goldSha: taskMeta.goldSha,
      workRoot: join(runRoot, 'trials'),
      trialLabel,
    });
  } catch (err) {
    record.exit_reason = 'infrastructure_blocked';
    record.infrastructure_error = `isolation failure: ${err.message}`;
    return record;
  }

  const profile = createIsolatedProfile(join(runRoot, 'profiles', trialLabel));
  const inspection = inspectProfile(profile.env);
  if (!inspection.agentListStdout.includes('git-why-bench')) {
    record.exit_reason = 'infrastructure_blocked';
    record.infrastructure_error = 'isolated profile did not recognize the git-why-bench agent; see profile inspection log.';
    return record;
  }

  const usageCard = usageCardFor(arm);
  const commonPreamble = 'You are given a single task in the current repository. Source code and any permitted Git history are available; use your judgment about what to consult.';

  const trialResult = await runTrial({
    taskId,
    arm,
    repetition,
    model,
    cwd: workspace.workspaceDir,
    profileEnv: profile.env,
    commonPreamble,
    taskPrompt: taskMeta.promptText,
    usageCard,
    promptWorkDir: join(runRoot, 'prompts', trialLabel),
    budgets: BUDGETS,
  });

  if (isInfrastructureError(trialResult)) {
    record.exit_reason = 'infrastructure_error';
    record.infrastructure_error = trialResult.stderr || 'no events received from opencode process';
    return record;
  }

  record.wall_ms = trialResult.wallMs;
  record.tool_calls = trialResult.toolCallCount;
  record.history_calls = trialResult.toolCalls.filter((t) => t.tool === 'bash').length; // best-effort proxy; refine once git-why/zg are real bash invocations to grep for
  record.git_why_calls = null; // requires parsing bash tool inputs for "git why" once the CLI exists; not fabricated here
  record.zg_calls = null;
  record.input_tokens = trialResult.usage.inputTokens;
  record.output_tokens = trialResult.usage.outputTokens;
  record.cache_read_tokens = trialResult.usage.cacheReadTokens;
  record.cache_write_tokens = trialResult.usage.cacheWriteTokens;
  record.actual_billed_cost = trialResult.actualBilledCost;
  record.estimated_list_price_cost = null; // zero-priced free-tier models: no list price to estimate
  record.tool_output_bytes = JSON.stringify(trialResult.rawEvents).length;
  record.exit_reason = trialResult.exitReason;
  record.treatment_error = trialResult.exitCode !== 0 ? `opencode exited ${trialResult.exitCode}` : null;

  const grading = gradeTrial({
    taskMeta,
    trialResult,
    trialWorkspaceDir: workspace.workspaceDir,
    hiddenTestPath: taskMeta.hiddenTestPath,
    rubric: taskMeta.rubric,
    scratchRoot: join(runRoot, 'grading-scratch'),
    reviewDir,
    promptText: taskMeta.promptText,
  });
  record.pass = grading.pass;
  record.hidden_tests_passed = grading.hiddenTestsPassed;
  record.hidden_tests_total = grading.hiddenTestsTotal;
  record.evidence_grade = grading.evidenceGrade;
  record.review_packet_id = grading.reviewPacketId ?? null;

  return record;
}

function gitHeadOfThisRepoOrNull() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}
function opencodeVersion() {
  const res = spawnSync('opencode', ['--version'], { encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : null;
}
function zgVersion() {
  const res = spawnSync('zg', ['--version'], { encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : null;
}
function gitVersion() {
  const res = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : null;
}
function loadProtocolHash() {
  try {
    return JSON.parse(readFileSync(join(REPO_ROOT, 'bench', 'protocol.json'), 'utf8')).protocolHash;
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const isSmoke = args.stage === 'smoke';
  const isPilot = args.stage === 'pilot';
  if (!isSmoke && !isPilot) fail(`--stage must be "smoke" or "pilot", got "${args.stage}"`);

  const taskIds = args.only ?? (isSmoke ? SMOKE_TASK_IDS : ALL_TASK_IDS);
  const repetitions = args.repetitions ?? (isSmoke ? 1 : 2);

  for (const taskId of taskIds) {
    const srcDir = join(SOURCE_REPOS_DIR, taskId);
    if (!existsSync(srcDir)) fail(`Task source repo missing for ${taskId}. Run: node bench/agents/tasks/build.mjs`);
  }

  const zgAvailable = checkZgAvailable();
  console.log(`[bench/agents] zg available: ${zgAvailable}`);
  if (!zgAvailable) {
    console.warn('[bench/agents] zg is not installed. Arms B and C will be recorded as infrastructure_blocked, not skipped or faked.');
  }

  const taskMetaById = Object.fromEntries(taskIds.map((id) => [id, loadTaskMeta(id)]));

  const plan = buildPlan({ taskIds, repetitions, seed: `git-why-bench::agents::${args.stage}::v1` });
  const plannedCount = plan.length;
  console.log(`[bench/agents] planned ${plannedCount} trials (${taskIds.length} tasks x ${ARMS.length} arms x ${repetitions} repetitions)`);

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runRoot = join(WORK_ROOT, `${args.stage}-${runId}`);
  const outDir = join(RESULTS_DIR, `${args.stage}-${runId}`);
  const reviewDir = join(outDir, 'review-packets');
  mkdirSync(outDir, { recursive: true });

  const records = await pooledMap(plan, TOTAL_CONCURRENCY, (item) =>
    runOnePlannedTrial(item, { taskMetaById, model: args.model, runRoot, reviewDir, zgAvailable, attempt: 1 }),
  );

  // Predeclared single retry for infrastructure-failed blocks, retaining
  // both attempts (never a free re-roll for a low-scoring-but-valid run).
  const retryTargets = records.filter((r) => r.exit_reason === 'infrastructure_error');
  const retryRecords = await pooledMap(
    retryTargets.map((r) => ({ taskId: r.task_id, arm: r.arm, repetition: r.repetition })),
    TOTAL_CONCURRENCY,
    (item) => runOnePlannedTrial(item, { taskMetaById, model: args.model, runRoot, reviewDir, zgAvailable, attempt: 2 }),
  );

  const allRecords = [...records, ...retryRecords];
  writeFileSync(join(outDir, 'trials.json'), JSON.stringify(allRecords, null, 2));

  const attempted = allRecords.length;
  const blocked = allRecords.filter((r) => r.exit_reason === 'infrastructure_blocked').length;
  const infraFailed = allRecords.filter((r) => r.exit_reason === 'infrastructure_error').length;
  const valid = allRecords.filter((r) => r.exit_reason !== 'infrastructure_blocked' && r.exit_reason !== 'infrastructure_error').length;
  const successful = allRecords.filter((r) => r.pass === true).length;

  const summary = {
    stage: args.stage,
    runId,
    model: args.model,
    zgAvailable,
    planned: plannedCount,
    attempted,
    blocked,
    infrastructureFailedAfterRetry: allRecords.filter((r) => r.attempt === 2 && r.exit_reason === 'infrastructure_error').length,
    valid,
    successful,
    byArm: Object.fromEntries(
      ARMS.map((arm) => {
        const armRecords = allRecords.filter((r) => r.arm === arm);
        return [
          arm,
          {
            attempted: armRecords.length,
            blocked: armRecords.filter((r) => r.exit_reason === 'infrastructure_blocked').length,
            valid: armRecords.filter((r) => r.exit_reason !== 'infrastructure_blocked' && r.exit_reason !== 'infrastructure_error').length,
            pass: armRecords.filter((r) => r.pass === true).length,
          },
        ];
      }),
    ),
  };
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));

  console.log(`\n[bench/agents] wrote ${attempted} trial records to ${outDir}`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
