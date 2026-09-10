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
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  renameSync,
  readdirSync,
  cpSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

import { buildIsolatedTrialWorkspace } from './isolation.mjs';
import { createIsolatedProfile, inspectProfile, runTrial } from './runner.mjs';
import { gradeTrial } from './grade.mjs';
import { auditTrajectory } from './audit.mjs';
import { aggregateAgentRecords } from './aggregate.mjs';
import { printChecklist, smokePostflight, smokePreflight } from './smoke.mjs';
import { benchWorkSubdir } from '../lib/workdir.mjs';
import { mulberry32, seedFromString, shuffle } from '../fixtures/lib/rng.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const TASKS_DIR = join(HERE, 'tasks');
// The committed task catalog intentionally has no prompt, base/gold SHA,
// rubric, hidden test, or source-repository path. Those are evaluator-only
// inputs outside the worktree, so no agent can reach them through a parent
// directory or a Docker mount.
const CATALOG_DIR = join(TASKS_DIR, 'manifests');
const EVALUATOR_DIR = benchWorkSubdir('evaluator', 'agents');
const PRIVATE_MANIFEST_DIR = join(EVALUATOR_DIR, 'manifests');
const PRIVATE_TASK_DIR = join(EVALUATOR_DIR, 'tasks');
const WORK_ROOT = benchWorkSubdir('agents-runs');
const RESULTS_DIR = join(REPO_ROOT, 'bench', 'results', 'agents');
const USAGE_CARDS_DIR = join(HERE, 'usage-cards');
const PACKAGED_TOOL_DIR = benchWorkSubdir('tools', 'git-why');
const INDEX_CACHE_ROOT = benchWorkSubdir('agent-index-cache');
const DASHBOARD_STATUS_FILE = join(REPO_ROOT, 'site', 'public', 'bench-status.json');

const ARMS = ['A', 'B', 'C', 'D'];

// Model calibrated by a tiny neutral run during harness development
// (read a file, trivial edit, produce valid output) -- see bench/README.md.
// Re-run calibration before trusting this choice for a real pilot; free
// model availability changes.
const DEFAULT_MODEL = 'opencode/big-pickle';

// Output tokens are measured in full but deliberately not capped. A model
// can spend more text reasoning through a difficult history task without
// being silently converted into a failed treatment. Wall-clock and tool-call
// limits remain the bounded, protocol-visible safety controls.
const BUDGETS = { wallClockMs: 8 * 60_000, toolCalls: 60, generatedTokens: null };
const TOTAL_CONCURRENCY = 2;

function parseArgs(argv) {
  const args = {
    stage: 'smoke',
    only: null,
    model: DEFAULT_MODEL,
    repetitions: null,
    resume: null,
  };
  for (const a of argv) {
    if (a.startsWith('--stage=')) args.stage = a.slice('--stage='.length);
    else if (a.startsWith('--only=')) args.only = a.slice('--only='.length).split(',');
    else if (a.startsWith('--model=')) args.model = a.slice('--model='.length);
    else if (a.startsWith('--repetitions='))
      args.repetitions = Number(a.slice('--repetitions='.length));
    else if (a.startsWith('--resume=')) args.resume = a.slice('--resume='.length);
  }
  return args;
}

function sha256(...parts) {
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}
function atomicJson(path, value) {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
  renameSync(temp, path);
}
function trialKey({
  taskId,
  arm,
  repetition,
  protocolHash,
  implementationSha,
  model,
  manifestHash,
}) {
  return sha256(
    taskId,
    arm,
    repetition,
    protocolHash ?? '',
    implementationSha ?? '',
    model,
    manifestHash ?? '',
  );
}
function completedTrial(path) {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return data.completed === true ? data : null;
  } catch {
    return null;
  }
}

// Agent executions have host shell access; only the benchmark image is a
// valid execution environment.  Refuse to accidentally run an unsandboxed
// paid/free session. `git-why-bench:local` is the reproducible image built
// from bench/agents/Dockerfile; deployments may override it explicitly.
function requireSandboxImage() {
  const image = process.env.BENCH_SANDBOX_IMAGE || 'git-why-bench:local';
  const docker = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
  });
  if (docker.status !== 0)
    return { ok: false, reason: 'Docker daemon unavailable; no agent trial may run unsandboxed.' };
  const inspect = spawnSync('docker', ['image', 'inspect', image], { encoding: 'utf8' });
  if (inspect.status !== 0) return { ok: false, reason: `sandbox image ${image} is unavailable.` };
  const context = spawnSync(
    'docker',
    ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
    {
      encoding: 'utf8',
    },
  );
  return {
    ok: true,
    image,
    dockerVersion: docker.stdout.trim(),
    dockerHost: context.status === 0 ? context.stdout.trim() : undefined,
  };
}

function fail(msg) {
  console.error(`\n[bench/agents] FAILED: ${msg}\n`);
  process.exit(1);
}

export function checkZgAvailable() {
  const res = spawnSync('zg', ['--version'], { encoding: 'utf8' });
  return res.status === 0;
}

function catalogEntries() {
  if (!existsSync(CATALOG_DIR))
    fail('task catalog missing. Run: node bench/agents/tasks/build.mjs');
  return readdirSync(CATALOG_DIR)
    .filter((name) => /^T\d+\.json$/.test(name))
    .map((name) => JSON.parse(readFileSync(join(CATALOG_DIR, name), 'utf8')))
    .sort((a, b) => Number(a.taskId.slice(1)) - Number(b.taskId.slice(1)));
}

function privateManifestPath(taskId) {
  return join(PRIVATE_MANIFEST_DIR, `${taskId}.json`);
}

function loadTaskMeta(taskId) {
  const manifestPath = privateManifestPath(taskId);
  if (!existsSync(manifestPath)) {
    fail(`No evaluator manifest for task ${taskId}. Run: node bench/agents/tasks/build.mjs`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const taskDir = join(PRIVATE_TASK_DIR, taskId);
  const promptPath = join(taskDir, 'prompt.md');
  const hiddenTestPath = join(taskDir, 'task.test.cjs');
  const rubricPath = join(taskDir, 'rubric.json');
  return {
    taskId,
    kind: manifest.kind,
    stratum: manifest.stratum,
    baseSha: manifest.baseSha,
    goldSha: manifest.goldSha,
    sourceRepoDir: manifest.sourceRepoDir,
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

function preparePackagedGitWhy() {
  const tarballsDir = benchWorkSubdir('tools', 'tarballs');
  rmSync(PACKAGED_TOOL_DIR, { recursive: true, force: true });
  mkdirSync(tarballsDir, { recursive: true });
  const packed = execFileSync('npm', ['pack', '--pack-destination', tarballsDir, '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  // npm's `pack --json` shape has changed across versions: older npm prints
  // an array of pack results, npm 12.0.2 (pinned here) prints an object
  // keyed by package name. Handle both rather than assuming one.
  const parsedPack = JSON.parse(packed);
  const packEntry = Array.isArray(parsedPack) ? parsedPack[0] : Object.values(parsedPack)[0];
  const tarball = packEntry?.filename;
  if (typeof tarball !== 'string') throw new Error('npm pack did not report a tarball filename');
  execFileSync(
    'npm',
    [
      'install',
      '--prefix',
      PACKAGED_TOOL_DIR,
      '--no-audit',
      '--fund=false',
      join(tarballsDir, tarball),
    ],
    { cwd: REPO_ROOT, stdio: 'inherit' },
  );
  const binDir = join(PACKAGED_TOOL_DIR, 'node_modules', '.bin');
  if (!existsSync(join(binDir, 'git-why')))
    throw new Error('packed git-why did not install its executable');
  return binDir;
}

function indexCacheKey({ baseSha, implementationSha, protocolHash, treatment, toolVersion }) {
  return sha256(
    baseSha,
    implementationSha ?? '',
    protocolHash ?? '',
    treatment,
    toolVersion ?? 'unknown',
  );
}

function cacheIndex({ key, kind, workspaceDir, relativePath, validate }) {
  const cacheDir = join(INDEX_CACHE_ROOT, key, kind);
  const target = join(workspaceDir, relativePath);
  const restore = () => {
    if (!existsSync(cacheDir)) return null;
    try {
      rmSync(target, { recursive: true, force: true });
      cpSync(cacheDir, target, { recursive: true });
      return validate();
    } catch {
      rmSync(target, { recursive: true, force: true });
      return null;
    }
  };
  const cached = restore();
  if (cached) return { ...cached, cache: 'hit' };
  return {
    cache: 'miss',
    store(value) {
      const staging = `${cacheDir}.staging-${process.pid}-${Date.now()}`;
      mkdirSync(join(INDEX_CACHE_ROOT, key), { recursive: true });
      rmSync(staging, { recursive: true, force: true });
      cpSync(target, staging, { recursive: true });
      // Another concurrent arm may have completed this exact immutable key.
      if (!existsSync(cacheDir)) renameSync(staging, cacheDir);
      else rmSync(staging, { recursive: true, force: true });
      return { ...value, cache: 'rebuilt' };
    },
  };
}

function gitWhyStatus(workspaceDir, toolPath) {
  const executable = join(toolPath, 'git-why');
  const env = { ...process.env, PATH: `${toolPath}:${process.env.PATH ?? ''}` };
  const status = spawnSync(executable, ['status', '--json', '--check-ready'], {
    cwd: workspaceDir,
    env,
    encoding: 'utf8',
  });
  if (status.status !== 0)
    throw new Error(
      `git why status --check-ready failed: ${status.stderr || status.stdout || `exit ${status.status}`}`,
    );
  const parsed = JSON.parse(status.stdout);
  const indexed = parsed?.index?.indexedCommits;
  const reachable = Number(
    spawnSync('git', ['rev-list', '--count', 'HEAD'], {
      cwd: workspaceDir,
      encoding: 'utf8',
    }).stdout.trim(),
  );
  if (indexed !== reachable)
    throw new Error(`git why index coverage mismatch: indexed ${indexed}, reachable ${reachable}`);
  return {
    diskBytes: parsed?.index?.diskBytes ?? null,
    corpusFingerprint: spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: workspaceDir,
      encoding: 'utf8',
    }).stdout.trim(),
    indexedCommits: indexed,
  };
}

function gitWhyVersion(toolPath) {
  const result = spawnSync(join(toolPath, 'git-why'), ['--version'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function buildFrozenGitWhyIndex(workspaceDir, toolPath) {
  const started = Date.now();
  const executable = join(toolPath, 'git-why');
  const env = { ...process.env, PATH: `${toolPath}:${process.env.PATH ?? ''}` };
  const result = spawnSync(executable, ['index'], { cwd: workspaceDir, env, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `git why index failed: ${result.stderr || result.stdout || `exit ${result.status}`}`,
    );
  }
  const checked = gitWhyStatus(workspaceDir, toolPath);
  return {
    buildMs: Date.now() - started,
    ...checked,
  };
}

function buildFrozenZgIndex(workspaceDir, sandbox) {
  const started = Date.now();
  // A clone may only carry an index generated for this exact execution
  // namespace. In particular, a host-generated zg collection records host
  // absolute paths and cannot be reused under /workspace in Docker.
  rmSync(join(workspaceDir, '.zvec-grep'), { recursive: true, force: true });
  const inContainer = (args) =>
    spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        sandbox.network ?? 'bridge',
        '--mount',
        `type=bind,src=${workspaceDir},dst=/workspace`,
        '--workdir',
        '/workspace',
        '--entrypoint',
        'zg',
        sandbox.image,
        ...args,
      ],
      {
        // Preserve Docker Desktop's chosen context; the agent's credential
        // profile is not involved in index construction.
        env: { ...process.env, ...(sandbox.dockerHost ? { DOCKER_HOST: sandbox.dockerHost } : {}) },
        encoding: 'utf8',
      },
    );
  // zg persists absolute workspace paths in its collection. Building it on
  // the host made a ready-looking index that was unusable from /workspace in
  // the trial container. Build through the same container mount instead.
  const index = inContainer([
    'index',
    '--embedding',
    'local/potion-code-16m-v2',
    '--glob',
    '!bench/agents/**',
  ]);
  if (index.status !== 0)
    throw new Error(`zg index failed: ${index.stderr || index.stdout || `exit ${index.status}`}`);
  const status = inContainer(['status', '--check-ready']);
  if (status.status !== 0)
    throw new Error(
      `zg status --check-ready failed: ${status.stderr || status.stdout || `exit ${status.status}`}`,
    );
  return { buildMs: Date.now() - started, status: status.stdout.trim() };
}

function validateZgIndex(workspaceDir, sandbox) {
  const status = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      sandbox.network ?? 'bridge',
      '--mount',
      `type=bind,src=${workspaceDir},dst=/workspace`,
      '--workdir',
      '/workspace',
      '--entrypoint',
      'zg',
      sandbox.image,
      'status',
      '--check-ready',
    ],
    {
      env: { ...process.env, ...(sandbox.dockerHost ? { DOCKER_HOST: sandbox.dockerHost } : {}) },
      encoding: 'utf8',
    },
  );
  if (status.status !== 0)
    throw new Error(
      `zg status --check-ready failed: ${status.stderr || status.stdout || `exit ${status.status}`}`,
    );
  return { status: status.stdout.trim() };
}

function commandInstrumentation(toolCalls, finalAnswer, finalPatch) {
  const bash = toolCalls.filter((call) => call.tool === 'bash');
  const text = (call) => JSON.stringify(call.input ?? '');
  const history = bash.filter((call) =>
    /\bgit\s+(?:log|show|blame)\b|\bgit\s+log\s+[^\n]*(?:-[SG])/.test(text(call)),
  );
  const gitWhy = bash
    .filter((call) => /(?:\bgit\s+why\b|\bgit-why\b)/.test(text(call)))
    .map((call) => {
      const output = JSON.stringify(call.output ?? '');
      const shas = output.match(/\b[0-9a-f]{7,40}\b/gi) ?? [];
      const used = shas.some(
        (sha) => (finalAnswer ?? '').includes(sha) || (finalPatch ?? '').includes(sha),
      );
      return { status: call.status, result_count: shas.length, evidence_used: used };
    });
  const zg = bash
    .filter((call) => /\bzg\b/.test(text(call)))
    .map((call) => {
      const output = String(call.output ?? '');
      const hits = output.match(/^#\d+\s/m)?.length ?? 0;
      return { status: call.status, result_count: hits, output_nonempty: output.trim().length > 0 };
    });
  return { history, gitWhy, zg };
}

function forcedUseSatisfied(arm, instrumentation) {
  const calls = armNeedsZg(arm) ? instrumentation.zg : arm === 'D' ? instrumentation.gitWhy : null;
  if (calls === null) return true;
  return calls.some((call) => call.status === 'completed' && call.result_count > 0);
}

function writeDashboardStatus(agent) {
  let prior = {};
  try {
    prior = JSON.parse(readFileSync(DASHBOARD_STATUS_FILE, 'utf8'));
  } catch {
    // The dashboard is optional for headless benchmark use; its absence must
    // never invalidate a benchmark result.
  }
  writeFileSync(
    DASHBOARD_STATUS_FILE,
    JSON.stringify({ ...prior, updatedAt: new Date().toISOString(), agent }, null, 2) + '\n',
  );
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
      if (block.arms[i])
        plan.push({ taskId: block.taskId, repetition: block.repetition, arm: block.arms[i] });
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

/**
 * Detects a provider-side rate limit (opencode's free "Console"/zen gateway
 * returns HTTP 429 with `error.type: "FreeUsageLimitError"`, an
 * `isRetryable: true` APIError event) among the raw session events. Measured
 * empirically 2026-09-10: the container/network/auth path was fine (the
 * request reached https://opencode.ai/zen/v1/chat/completions and got a
 * real 429 back); the free-tier quota was exhausted by prior trials, not a
 * harness bug. This is a transient provider outage from the runner's
 * perspective, not a model outcome -- it must not be scored as a trial
 * failure (wrong answer) or an isolation/preflight violation.
 */
function isRateLimitError(trialResult) {
  return (trialResult.rawEvents ?? []).some((evt) => {
    if (evt?.type !== 'error') return false;
    const data = evt.error?.data;
    return data?.statusCode === 429 || data?.isRetryable === true;
  });
}

function isInfrastructureError(trialResult) {
  // A process-level failure to even reach the model (spawn error, provider
  // outage before any step_finish) is infrastructure; a completed run with
  // a wrong/incomplete answer is a model outcome, not infrastructure.
  return (
    (trialResult.exitCode === null && trialResult.eventCount === 0) ||
    isRateLimitError(trialResult)
  );
}

async function runOnePlannedTrial(
  planItem,
  {
    taskMetaById,
    model,
    runRoot,
    reviewDir,
    zgAvailable,
    toolPath,
    sandbox,
    attempt,
    outDir,
    isSmoke,
  },
) {
  const { taskId, arm, repetition } = planItem;
  const taskMeta = taskMetaById[taskId];
  const trialLabel = `${taskId}-${arm}-r${repetition}-a${attempt}`;

  const record = {
    task_id: taskId,
    task_stratum: taskMeta.stratum,
    arm,
    repetition,
    base_sha: taskMeta.baseSha,
    // Base SHA is the immutable corpus snapshot fingerprint for every arm,
    // including baseline. Treatment preparation records the same value after
    // its status assertion.
    corpus_fingerprint: taskMeta.baseSha,
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
    dependency_lock_hash: existsSync(join(REPO_ROOT, 'package-lock.json'))
      ? sha256(readFileSync(join(REPO_ROOT, 'package-lock.json'), 'utf8'))
      : null,
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
    events_file: null,
    exit_reason: null,
    infrastructure_error: null,
    treatment_error: null,
    invalidation_reason: null,
    attempt,
  };
  const manifestHash = sha256(readFileSync(privateManifestPath(taskId), 'utf8'));
  record.key = trialKey({
    taskId,
    arm,
    repetition,
    protocolHash: record.protocol_hash,
    implementationSha: record.implementation_sha,
    model,
    manifestHash,
  });
  const recordPath = join(outDir, 'trials', `${record.key}.json`);
  mkdirSync(join(outDir, 'trials'), { recursive: true });
  function finish() {
    record.completed = true;
    atomicJson(recordPath, record);
    return record;
  }

  if (armNeedsZg(arm) && !zgAvailable) {
    record.exit_reason = 'infrastructure_blocked';
    record.infrastructure_error =
      'zg not installed on PATH; arm requires zg per protocol. See bench/protocol.json arms.B/C.status.';
    return finish();
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
    return finish();
  }

  if (arm === 'C' || arm === 'D') {
    try {
      const cache = cacheIndex({
        key: indexCacheKey({
          baseSha: taskMeta.baseSha,
          implementationSha: record.implementation_sha,
          protocolHash: record.protocol_hash,
          treatment: 'git-why',
          toolVersion: gitWhyVersion(toolPath),
        }),
        kind: 'git-why',
        workspaceDir: workspace.workspaceDir,
        relativePath: join('.git', 'why'),
        validate: () => gitWhyStatus(workspace.workspaceDir, toolPath),
      });
      const prepared =
        cache.cache === 'hit'
          ? { ...cache, buildMs: 0 }
          : cache.store(buildFrozenGitWhyIndex(workspace.workspaceDir, toolPath));
      record.index_build_ms = prepared.buildMs;
      record.index_disk_bytes = prepared.diskBytes;
      record.corpus_fingerprint = prepared.corpusFingerprint;
      record.indexed_commits = prepared.indexedCommits;
      record.git_why_index_cache = prepared.cache;
    } catch (err) {
      record.exit_reason = 'infrastructure_blocked';
      record.infrastructure_error = `git-why index preparation failure: ${err.message}`;
      return finish();
    }
  }

  if (armNeedsZg(arm)) {
    try {
      const cache = cacheIndex({
        key: indexCacheKey({
          baseSha: taskMeta.baseSha,
          implementationSha: record.implementation_sha,
          protocolHash: record.protocol_hash,
          treatment: 'zg',
          toolVersion: `${sandbox.image}:${record.zg_version ?? 'container-zg'}`,
        }),
        kind: 'zg',
        workspaceDir: workspace.workspaceDir,
        relativePath: '.zvec-grep',
        validate: () => validateZgIndex(workspace.workspaceDir, sandbox),
      });
      const prepared =
        cache.cache === 'hit'
          ? { ...cache, buildMs: 0 }
          : cache.store(buildFrozenZgIndex(workspace.workspaceDir, sandbox));
      record.zg_index_build_ms = prepared.buildMs;
      record.zg_status = prepared.status;
      record.zg_index_cache = prepared.cache;
    } catch (err) {
      record.exit_reason = 'infrastructure_blocked';
      record.infrastructure_error = `zg index preparation failure: ${err.message}`;
      return finish();
    }
  }

  const profile = createIsolatedProfile(join(runRoot, 'profiles', trialLabel), { toolPath });
  const inspection = inspectProfile(profile.env);
  if (!inspection.agentListStdout.includes('git-why-bench')) {
    record.exit_reason = 'infrastructure_blocked';
    record.infrastructure_error =
      'isolated profile did not recognize the git-why-bench agent; see profile inspection log.';
    return finish();
  }

  const usageCard = usageCardFor(arm);
  const trialDir = sandbox ? '/workspace' : workspace.workspaceDir;
  const forcedUse =
    isSmoke && armNeedsZg(arm)
      ? ' After that preflight, before the task, run `zg query --fts function --limit 1` and confirm it returns a hit.'
      : isSmoke && arm === 'D'
        ? ' After that preflight, before the task, run `git why "function" --no-refresh -n 1` and confirm it returns a result.'
        : '';
  const commonPreamble = `You are given a single task in the current repository. BEFORE any other shell command, run exactly one bash command that prints: pwd; git rev-parse --show-toplevel; git rev-parse HEAD. Verify they equal ${trialDir}, ${trialDir}, and ${taskMeta.baseSha}. Then work only inside this repository. Source code and permitted Git history are available; use your judgment about whether to consult it.${forcedUse}`;
  // Hash only non-secret, trial-visible inputs. The profile credential is
  // deliberately excluded: it is copied into an ephemeral mount and must
  // never become benchmark data.
  record.profile_hash = sha256(
    readFileSync(
      join(profile.profileRoot, '.config', 'opencode', 'agent', 'git-why-bench.md'),
      'utf8',
    ),
  );
  record.prompt_hash = sha256(commonPreamble, taskMeta.promptText, usageCard ?? '');

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
    sandbox: sandbox ? { ...sandbox, profileRoot: profile.profileRoot } : null,
    budgets: BUDGETS,
  });

  if (isInfrastructureError(trialResult)) {
    record.exit_reason = 'infrastructure_error';
    record.infrastructure_error = isRateLimitError(trialResult)
      ? `provider rate limit: ${(trialResult.rawEvents ?? []).find((e) => e?.type === 'error')?.error?.data?.message ?? 'rate limit exceeded'}`
      : trialResult.stderr || 'no events received from opencode process';
    return finish();
  }

  record.wall_ms = trialResult.wallMs;
  record.tool_calls = trialResult.toolCallCount;
  const instrumentation = commandInstrumentation(
    trialResult.toolCalls,
    trialResult.finalAnswer,
    trialResult.finalPatch,
  );
  record.history_calls = instrumentation.history.length;
  record.git_why_calls = instrumentation.gitWhy.length;
  record.zg_calls = instrumentation.zg.length;
  record.command_instrumentation = instrumentation;
  record.forced_use_probe = isSmoke && arm !== 'A';
  record.forced_use_passed = record.forced_use_probe
    ? forcedUseSatisfied(arm, instrumentation)
    : null;
  record.input_tokens = trialResult.usage.inputTokens;
  record.output_tokens = trialResult.usage.outputTokens;
  record.cache_read_tokens = trialResult.usage.cacheReadTokens;
  record.cache_write_tokens = trialResult.usage.cacheWriteTokens;
  record.actual_billed_cost = trialResult.actualBilledCost;
  record.estimated_list_price_cost = null; // zero-priced free-tier models: no list price to estimate
  record.tool_output_bytes = JSON.stringify(trialResult.rawEvents).length;
  record.exit_reason = trialResult.exitReason;
  record.treatment_error =
    trialResult.exitCode !== 0 ? `opencode exited ${trialResult.exitCode}` : null;
  if (record.forced_use_probe && !record.forced_use_passed) {
    record.treatment_error =
      'forced-use probe did not produce a successful non-empty treatment result';
  }

  const eventsDir = join(runRoot, 'events');
  mkdirSync(eventsDir, { recursive: true });
  const eventsFile = join(eventsDir, `${trialLabel}.jsonl`);
  writeFileSync(
    eventsFile,
    trialResult.rawEvents.map((event) => JSON.stringify(event)).join('\n') + '\n',
  );
  record.events_file = eventsFile;
  const artifactsDir = join(runRoot, 'artifacts');
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(join(artifactsDir, `${trialLabel}.answer.txt`), trialResult.finalAnswer ?? '');
  writeFileSync(join(artifactsDir, `${trialLabel}.patch.diff`), trialResult.finalPatch ?? '');
  writeFileSync(join(artifactsDir, `${trialLabel}.stderr.txt`), trialResult.stderr ?? '');
  const audit = auditTrajectory({
    rawEvents: trialResult.rawEvents,
    toolCalls: trialResult.toolCalls,
    workspaceDir: workspace.workspaceDir,
    executionWorkspaceDir: trialDir,
    baseSha: taskMeta.baseSha,
  });
  record.trajectory_audit = audit;
  record.invalidation_reason = audit.invalidation_reason;

  // A model result is only gradeable after it completed cleanly and passed
  // the trajectory audit. Running hidden tests against an unchanged clone
  // after Docker/OpenCode failed made a broken trial look like a success.
  if (record.treatment_error !== null || record.invalidation_reason !== null) {
    record.pass = null;
    return finish();
  }

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

  return finish();
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

  const catalog = catalogEntries();
  const allTaskIds = catalog.map((entry) => entry.taskId);
  // Smoke samples each behavioral stratum plus a direct current-code control.
  // The public catalog carries enough non-sensitive metadata to choose these
  // without opening evaluator material until the selected IDs are known.
  const smokeKinds = [
    'revert_and_reapply',
    'evidence_question',
    'temporal_history',
    'current_code_control',
  ];
  const smokeTaskIds = smokeKinds.map((kind) => {
    const entry = catalog.find((candidate) => candidate.kind === kind);
    if (!entry) fail(`smoke corpus is missing required task kind: ${kind}`);
    return entry.taskId;
  });
  const taskIds = args.only ?? (isSmoke ? smokeTaskIds : allTaskIds);
  const repetitions = args.repetitions ?? (isSmoke ? 1 : 2);

  const sandbox = requireSandboxImage();

  const taskMetaById = Object.fromEntries(taskIds.map((id) => [id, loadTaskMeta(id)]));
  for (const taskId of taskIds) {
    const srcDir = taskMetaById[taskId].sourceRepoDir;
    if (!srcDir || !existsSync(srcDir))
      fail(`Task source repo missing for ${taskId}. Run: node bench/agents/tasks/build.mjs`);
  }

  const zgAvailable = checkZgAvailable();
  console.log(`[bench/agents] zg available: ${zgAvailable}`);
  if (!zgAvailable) {
    console.warn(
      '[bench/agents] zg is not installed. Arms B and C will be recorded as infrastructure_blocked, not skipped or faked.',
    );
  }

  const toolPath = preparePackagedGitWhy();
  if (isSmoke) {
    const checks = smokePreflight({ toolPath, sandbox });
    if (!printChecklist(checks))
      fail('smoke checklist has one or more failures; no agent trial was started.');
  }
  if (!sandbox.ok) fail(`sandbox gate: ${sandbox.reason}`);

  const plan = buildPlan({
    taskIds,
    repetitions,
    seed: `git-why-bench::agents::${args.stage}::v1`,
  });
  const plannedCount = plan.length;
  console.log(
    `[bench/agents] planned ${plannedCount} trials (${taskIds.length} tasks x ${ARMS.length} arms x ${repetitions} repetitions)`,
  );

  const runId = args.resume ?? new Date().toISOString().replace(/[:.]/g, '-');
  const runRoot = join(WORK_ROOT, `${args.stage}-${runId}`);
  const outDir = join(RESULTS_DIR, `${args.stage}-${runId}`);
  const reviewDir = join(outDir, 'review-packets');
  mkdirSync(outDir, { recursive: true });

  writeDashboardStatus({
    state: 'running',
    stage: `${isSmoke ? 'Smoke' : 'Pilot'} · ${taskIds.join(', ')}`,
    runId,
    planned: plannedCount,
    completed: 0,
    note: 'Live isolated OpenCode trials are in progress.',
  });

  const resumable = plan.filter((item) => {
    const manifestHash = sha256(readFileSync(privateManifestPath(item.taskId), 'utf8'));
    const key = trialKey({
      taskId: item.taskId,
      arm: item.arm,
      repetition: item.repetition,
      protocolHash: loadProtocolHash(),
      implementationSha: gitHeadOfThisRepoOrNull(),
      model: args.model,
      manifestHash,
    });
    return !args.resume || !completedTrial(join(outDir, 'trials', `${key}.json`));
  });
  const records = await pooledMap(resumable, TOTAL_CONCURRENCY, (item) =>
    runOnePlannedTrial(item, {
      taskMetaById,
      model: args.model,
      runRoot,
      reviewDir,
      zgAvailable,
      toolPath,
      sandbox,
      attempt: 1,
      outDir,
      isSmoke,
    }),
  );

  // Predeclared single retry for infrastructure-failed blocks, retaining
  // both attempts (never a free re-roll for a low-scoring-but-valid run).
  const retryTargets = records.filter((r) => r.exit_reason === 'infrastructure_error');
  const retryRecords = await pooledMap(
    retryTargets.map((r) => ({ taskId: r.task_id, arm: r.arm, repetition: r.repetition })),
    TOTAL_CONCURRENCY,
    (item) =>
      runOnePlannedTrial(item, {
        taskMetaById,
        model: args.model,
        runRoot,
        reviewDir,
        zgAvailable,
        toolPath,
        sandbox,
        attempt: 2,
        outDir,
        isSmoke,
      }),
  );

  const allRecords = [...records, ...retryRecords];
  writeFileSync(join(outDir, 'trials.json'), JSON.stringify(allRecords, null, 2));

  const attempted = allRecords.length;
  const blocked = allRecords.filter((r) => r.exit_reason === 'infrastructure_blocked').length;

  const valid = allRecords.filter(
    (r) =>
      r.exit_reason !== 'infrastructure_blocked' &&
      r.exit_reason !== 'infrastructure_error' &&
      r.invalidation_reason === null &&
      r.treatment_error === null,
  ).length;
  const successful = allRecords.filter((r) => r.pass === true).length;

  const summary = {
    stage: args.stage,
    runId,
    model: args.model,
    zgAvailable,
    planned: plannedCount,
    attempted,
    blocked,
    infrastructureFailedAfterRetry: allRecords.filter(
      (r) => r.attempt === 2 && r.exit_reason === 'infrastructure_error',
    ).length,
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
            valid: armRecords.filter(
              (r) =>
                r.exit_reason !== 'infrastructure_blocked' &&
                r.exit_reason !== 'infrastructure_error' &&
                r.invalidation_reason === null &&
                r.treatment_error === null,
            ).length,
            pass: armRecords.filter((r) => r.pass === true).length,
          },
        ];
      }),
    ),
    // Stable, report/dashboard-ready analysis derived solely from the same
    // atomic records. Keep legacy top-level fields above for resume tooling.
    aggregate: aggregateAgentRecords(allRecords),
  };
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  writeDashboardStatus({
    state: 'completed',
    stage: isSmoke ? 'Smoke' : 'Pilot',
    runId,
    planned: plannedCount,
    completed: attempted,
    note: `${summary.valid} valid trials; ${summary.blocked} infrastructure-blocked.`,
  });

  console.log(`\n[bench/agents] wrote ${attempted} trial records to ${outDir}`);
  console.log(JSON.stringify(summary, null, 2));
  if (isSmoke) {
    const checks = smokePostflight({ records: allRecords, expectedTrials: plannedCount });
    if (!printChecklist(checks)) fail('smoke postflight checklist has one or more failures.');
  }
}

// Guarded, unlike the other bench/*/run.mjs entry points: this one spawns
// real OpenCode sessions (real, if free-tier, API usage) the instant it
// runs. `import()`-ing this module for a helper (e.g. checkZgAvailable)
// must never accidentally trigger a live run -- caught during harness
// validation when a diagnostic `import()` silently kicked off real trials.
const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
