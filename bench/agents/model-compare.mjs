/**
 * Shared cross-model comparison over agent pilot runs.
 *
 * Both `bench/compare-models.mjs` (the console view, used while tiers run) and
 * `bench/report.mjs` (the published document) read from here, so the two can
 * never drift into disagreeing about the same trials.
 *
 * Two rules do most of the work:
 *
 *   1. Runs still in flight are excluded. A directory without `summary.json`
 *      has trials landing into it as we read. Including one produced a "100%
 *      on n=1" row in an earlier draft of the report, which is exactly the
 *      shape of wrong number this project keeps catching late.
 *
 *   2. Everything comparative is PAIRED. Arm medians alone let task difficulty
 *      drive the result: if arm D happened to attempt the easier questions it
 *      looks better for a reason unrelated to the treatment.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const ARMS = ['A', 'B', 'C', 'D'];

export const median = (xs) => {
  const v = xs.filter((n) => typeof n === 'number' && Number.isFinite(n)).sort((a, b) => a - b);
  return v.length === 0 ? null : v[Math.floor(v.length / 2)];
};
const sum = (xs) => xs.reduce((a, b) => a + (b ?? 0), 0);

/**
 * Chooses between two trials of the same (task, arm).
 *
 * This happens when one model is run twice -- deepseek-v4-flash has an
 * original run and a re-run added once token reconciliation existed. Without a
 * rule, whichever the filesystem happened to list last won, which means the
 * paired comparison silently depended on readdir order.
 *
 * A trial whose token counts reconcile against the provider's own accounting
 * is strictly better evidence than one whose do not, so that wins first.
 * Failing that, the later trial wins, since it ran against newer code.
 */
export function preferTrial(a, b) {
  const rank = (r) =>
    r.token_cross_check_agrees === true ? 2 : r.token_cross_check_agrees === null ? 1 : 0;
  if (rank(b) !== rank(a)) return rank(b) > rank(a) ? b : a;
  return (b.__runId ?? '') >= (a.__runId ?? '') ? b : a;
}

/** A trial counts only if it ran to completion and produced a verdict. */
export function graded(records, arm) {
  return records.filter(
    (r) =>
      r.arm === arm &&
      !r.invalidation_reason &&
      r.exit_reason === 'completed' &&
      r.evidence_grade &&
      r.evidence_grade.goldSha,
  );
}

function loadRun(dir) {
  const trialsDir = join(dir, 'trials');
  if (!existsSync(trialsDir)) return [];
  // Trial records carry no timestamp of their own; the run directory name is
  // the ISO timestamp, so it is attached here to give `preferTrial` something
  // ordered to break ties on.
  const runId = dir.split('/').pop() ?? '';
  return readdirSync(trialsDir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => ({ ...JSON.parse(readFileSync(join(trialsDir, n), 'utf8')), __runId: runId }));
}

/**
 * @param {string} resultsDir   bench/results/agents
 * @param {{includeIncomplete?: boolean}} [opts]
 */
export function compareModels(resultsDir, opts = {}) {
  if (!existsSync(resultsDir)) return { rows: [], skipped: [] };

  const skipped = [];
  const runs = readdirSync(resultsDir)
    .filter((n) => n.startsWith('pilot-'))
    .map((n) => join(resultsDir, n))
    .filter((dir) => {
      if (opts.includeIncomplete || existsSync(join(dir, 'summary.json'))) return true;
      skipped.push(dir);
      return false;
    })
    .map((dir) => ({ dir, records: loadRun(dir) }))
    .filter((r) => r.records.length > 0);

  // Group by the model recorded on the trials, not by directory name: one
  // model can span several directories after a re-run.
  const byModel = new Map();
  for (const { records } of runs) {
    const model = records[0].model_id ?? 'unknown';
    if (!byModel.has(model)) byModel.set(model, { model, records: [] });
    byModel.get(model).records.push(...records);
  }

  const rows = [];
  for (const { model, records } of byModel.values()) {
    const arms = {};
    for (const arm of ARMS) {
      const g = graded(records, arm);
      arms[arm] = {
        n: g.length,
        hits: g.filter((r) => r.evidence_grade.citedGoldSha).length,
        calls: median(g.map((r) => r.tool_calls)),
        inTok: median(g.map((r) => r.input_tokens)),
        outTok: median(g.map((r) => r.output_tokens)),
        // Cost sums only trials whose token counts reconcile against the
        // provider's own database. A trial whose accounting disagrees has an
        // unreliable cost, and averaging it in would quietly corrupt the
        // column that matters most.
        cost: sum(
          g.filter((r) => r.token_cross_check_agrees !== false).map((r) => r.actual_billed_cost),
        ),
        verified: g.filter((r) => r.token_cross_check_agrees === true).length,
        unverified: g.filter((r) => r.token_cross_check_agrees === null).length,
        badTokens: g.filter((r) => r.token_cross_check_agrees === false).length,
      };
    }

    const paired = (x, y) => {
      const byTask = new Map();
      for (const arm of [x, y]) {
        for (const r of graded(records, arm)) {
          const e = byTask.get(r.task_id) ?? {};
          e[arm] = e[arm] === undefined ? r : preferTrial(e[arm], r);
          byTask.set(r.task_id, e);
        }
      }
      const both = [...byTask.values()].filter((e) => e[x] && e[y]);
      if (both.length === 0) return null;
      const correct = (r) => (r.evidence_grade.citedGoldSha ? 1 : 0);
      return {
        n: both.length,
        accWin: both.filter((e) => correct(e[y]) > correct(e[x])).length,
        accLoss: both.filter((e) => correct(e[x]) > correct(e[y])).length,
        callsDelta: median(both.map((e) => (e[y].tool_calls ?? 0) - (e[x].tool_calls ?? 0))),
        tokDelta: median(both.map((e) => (e[y].input_tokens ?? 0) - (e[x].input_tokens ?? 0))),
      };
    };

    rows.push({ model, arms, dVsA: paired('A', 'D'), cVsB: paired('B', 'C') });
  }

  rows.sort((a, b) => a.model.localeCompare(b.model));
  return { rows, skipped };
}
