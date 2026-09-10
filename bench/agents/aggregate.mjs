// Aggregation for agent benchmark records.  This deliberately lives outside
// the runner: reports and the dashboard must be reproducible from immutable
// trial JSON files, including after a crashed/resumed run.

const ARMS = ['A', 'B', 'C', 'D'];

export function isValidTrial(record) {
  return (
    record?.completed === true &&
    record.exit_reason !== 'infrastructure_blocked' &&
    record.exit_reason !== 'infrastructure_error' &&
    record.invalidation_reason == null &&
    record.treatment_error == null
  );
}

function numeric(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function mean(values) {
  const usable = values.filter((value) => numeric(value) !== null);
  return usable.length === 0 ? null : usable.reduce((sum, value) => sum + value, 0) / usable.length;
}

function outcome(record) {
  // Rubric trials deliberately have pass:null. They must never leak into a
  // coding success denominator merely because the trial itself was valid.
  return isValidTrial(record) && typeof record.pass === 'boolean' ? record.pass : null;
}

function logicalTrialKey(record) {
  return record.key ?? `${record.task_id}\0${record.arm}\0${record.repetition}`;
}

// A retry replaces an infrastructure-failed first attempt for outcome rates;
// raw resource accounting remains over every attempt below.
export function selectLogicalTrials(records) {
  const selected = new Map();
  for (const record of records) {
    const key = logicalTrialKey(record);
    const prior = selected.get(key);
    if (!prior || (record.attempt ?? 1) >= (prior.attempt ?? 1)) selected.set(key, record);
  }
  return [...selected.values()];
}

function summarizeOutcome(records) {
  const valid = records.filter(isValidTrial);
  const scored = valid.filter((record) => typeof record.pass === 'boolean');
  const pass = scored.filter((record) => record.pass).length;
  return {
    attempted: records.length,
    valid: valid.length,
    numerator: pass,
    denominator: scored.length,
    rate: scored.length === 0 ? null : pass / scored.length,
    unscoredValid: valid.length - scored.length,
  };
}

function resourceSummary(records) {
  const fields = [
    'wall_ms',
    'tool_calls',
    'history_calls',
    'git_why_calls',
    'zg_calls',
    'input_tokens',
    'output_tokens',
    'cache_read_tokens',
    'cache_write_tokens',
    'actual_billed_cost',
    'estimated_list_price_cost',
    'index_build_ms',
    'index_disk_bytes',
  ];
  const result = { n: records.length };
  for (const field of fields) {
    const values = records
      .map((record) => numeric(record[field]))
      .filter((value) => value !== null);
    result[field] = {
      total: values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0),
      mean: mean(values),
      observed: values.length,
    };
  }
  return result;
}

function mulberry32(seed) {
  return () => {
    let value = (seed += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(values, q) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

// Cluster resampling by task (not trial): repetitions within a task are
// correlated and are kept together.  This is descriptive uncertainty, never
// a significance test.
export function bootstrapTaskClusterCi(records, arm, baseline = 'A', iterations = 2000) {
  const byTask = new Map();
  for (const record of records) {
    if (!isValidTrial(record) || typeof record.pass !== 'boolean') continue;
    const task = record.task_id;
    if (!byTask.has(task)) byTask.set(task, new Map());
    const taskArms = byTask.get(task);
    if (!taskArms.has(record.arm)) taskArms.set(record.arm, []);
    taskArms.get(record.arm).push(record.pass ? 1 : 0);
  }
  const pairedTasks = [...byTask.values()].filter((arms) => arms.has(arm) && arms.has(baseline));
  if (pairedTasks.length === 0) return { clusters: 0, estimate: null, low: null, high: null };
  const delta = (clusters) =>
    mean(clusters.map((arms) => mean(arms.get(arm)) - mean(arms.get(baseline))));
  const estimate = delta(pairedTasks);
  const random = mulberry32(0x47574859 ^ arm.charCodeAt(0));
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const sample = Array.from(
      { length: pairedTasks.length },
      () => pairedTasks[Math.floor(random() * pairedTasks.length)],
    );
    samples.push(delta(sample));
  }
  return {
    clusters: pairedTasks.length,
    estimate,
    low: quantile(samples, 0.025),
    high: quantile(samples, 0.975),
  };
}

export function aggregateAgentRecords(rawRecords) {
  const records = rawRecords.filter((record) => record && typeof record === 'object');
  const logical = selectLogicalTrials(records);
  const strata = [...new Set(logical.map((record) => record.task_stratum ?? 'unknown'))].sort();
  const byStratumArm = {};
  for (const stratum of strata) {
    byStratumArm[stratum] = Object.fromEntries(
      ARMS.map((arm) => [
        arm,
        summarizeOutcome(
          logical.filter(
            (record) => (record.task_stratum ?? 'unknown') === stratum && record.arm === arm,
          ),
        ),
      ]),
    );
  }
  const byArm = Object.fromEntries(
    ARMS.map((arm) => [arm, summarizeOutcome(logical.filter((record) => record.arm === arm))]),
  );
  const taskKeys = [
    ...new Set(logical.map((record) => `${record.task_id}\0${record.task_stratum ?? 'unknown'}`)),
  ].sort();
  const pairedPerTask = taskKeys.map((key) => {
    const [taskId, stratum] = key.split('\0');
    const taskRecords = logical.filter(
      (record) => record.task_id === taskId && (record.task_stratum ?? 'unknown') === stratum,
    );
    return {
      taskId,
      stratum,
      arms: Object.fromEntries(
        ARMS.map((arm) => [
          arm,
          summarizeOutcome(taskRecords.filter((record) => record.arm === arm)),
        ]),
      ),
    };
  });
  const invalidated = records
    .filter((record) => record.invalidation_reason != null || record.treatment_error != null)
    .map((record) => ({
      taskId: record.task_id,
      stratum: record.task_stratum ?? 'unknown',
      arm: record.arm,
      repetition: record.repetition,
      attempt: record.attempt ?? 1,
      key: record.key ?? null,
      reason: record.invalidation_reason ?? record.treatment_error,
    }));
  const successful = logical.filter((record) => outcome(record) === true);
  const evidence = Object.fromEntries(
    ARMS.map((arm) => {
      const armRecords = logical.filter((record) => record.arm === arm);
      const calls = armRecords.flatMap((record) => record.command_instrumentation?.gitWhy ?? []);
      return [
        arm,
        {
          trialsWithGitWhy: armRecords.filter((record) => (record.git_why_calls ?? 0) > 0).length,
          gitWhyCalls: calls.length,
          gitWhyEvidenceUsed: calls.filter((call) => call.evidence_used === true).length,
          zgCalls: armRecords.reduce((sum, record) => sum + (record.zg_calls ?? 0), 0),
        },
      ];
    }),
  );
  return {
    schemaVersion: 1,
    attempts: records.length,
    logicalTrials: logical.length,
    valid: logical.filter(isValidTrial).length,
    successful: successful.length,
    byStratumArm,
    byArm,
    pairedPerTask,
    bootstrapCiByArm: Object.fromEntries(
      ARMS.map((arm) => [arm, bootstrapTaskClusterCi(logical, arm)]),
    ),
    resources: {
      allAttempts: resourceSummary(records),
      successfulOnly: resourceSummary(successful),
    },
    invalidated,
    evidence,
  };
}
