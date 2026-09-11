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

/**
 * Which task set a trial belongs to.
 *
 * `B-` tasks are six-question briefs scored 0..6; `X-` tasks are
 * single-question lookups scored pass/fail. Pooling them would average a score
 * into a bit and report the result as though one measurement had been made.
 */
export function taskFamily(taskId) {
  if (typeof taskId !== 'string') return 'unknown';
  if (taskId.startsWith('B-')) return 'brief';
  if (taskId.startsWith('X-')) return 'lookup';
  return 'other';
}

/**
 * The true median: the average of the two middle values when the count is
 * even, not the upper one.
 *
 * `v[Math.floor(v.length / 2)]` is right for odd counts and biased upward for
 * even ones, and the paired comparisons here run at n=6 to n=9 where even is
 * common. On gemini-3.1-flash-lite the per-task call deltas were
 * -114, -16, -13, +8, +11, +14: a true median of -2.5, reported as +8. The
 * tool halved the median tool calls for that model and the table said it cost
 * eight more.
 */
export const median = (xs) => {
  const v = xs.filter((n) => typeof n === 'number' && Number.isFinite(n)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
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

  // Group by model AND task family. One model can span several directories
  // after a re-run, which should pool — but a run against six-question briefs
  // and a run against single-question lookups must NOT, and they would have:
  // the grouping was by model alone, so a model's brief scores would have been
  // averaged into its older binary outcomes as though they measured the same
  // thing.
  const byGroup = new Map();
  for (const { records } of runs) {
    for (const record of records) {
      const model = record.model_id ?? 'unknown';
      const family = taskFamily(record.task_id);
      const key = `${model}\u0000${family}`;
      if (!byGroup.has(key)) byGroup.set(key, { model, family, records: [] });
      byGroup.get(key).records.push(record);
    }
  }

  const rows = [];
  for (const { model, family, records } of byGroup.values()) {
    const arms = {};
    for (const arm of ARMS) {
      const g = graded(records, arm);
      arms[arm] = {
        n: g.length,
        hits: g.filter((r) => r.evidence_grade.citedGoldSha).length,
        points: sum(
          g.map((r) => r.evidence_grade.score ?? (r.evidence_grade.citedGoldSha ? 1 : 0)),
        ),
        pointsOutOf: sum(g.map((r) => r.evidence_grade.outOf ?? 1)),
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
      // A brief scores 0..N; a single-question task scores 0 or 1. Reading the
      // score where one exists is what turns one bit per expensive agent
      // session into six, which is the whole reason the brief tasks exist.
      const correct = (r) =>
        typeof r.evidence_grade.score === 'number'
          ? r.evidence_grade.score
          : r.evidence_grade.citedGoldSha
            ? 1
            : 0;
      const outOf = (r) => r.evidence_grade.outOf ?? 1;
      const scored = both.filter((e) => typeof e[x].evidence_grade.score === 'number');
      return {
        n: both.length,
        accWin: both.filter((e) => correct(e[y]) > correct(e[x])).length,
        accLoss: both.filter((e) => correct(e[x]) > correct(e[y])).length,
        /** Total questions answered correctly, present only for brief tasks. */
        pointsX: scored.length > 0 ? sum(scored.map((e) => correct(e[x]))) : null,
        pointsY: scored.length > 0 ? sum(scored.map((e) => correct(e[y]))) : null,
        pointsOutOf: scored.length > 0 ? sum(scored.map((e) => outOf(e[x]))) : null,
        callsDelta: median(both.map((e) => (e[y].tool_calls ?? 0) - (e[x].tool_calls ?? 0))),
        tokDelta: median(both.map((e) => (e[y].input_tokens ?? 0) - (e[x].input_tokens ?? 0))),
        // A median over six tasks hides a split. On gemini-3.1-flash-lite the
        // tool saved 114, 16 and 13 calls on three tasks and cost 8, 11 and 14
        // on the others — one number cannot say that, so the direction count
        // is reported beside it.
        callsCheaper: both.filter((e) => (e[y].tool_calls ?? 0) < (e[x].tool_calls ?? 0)).length,
        callsDearer: both.filter((e) => (e[y].tool_calls ?? 0) > (e[x].tool_calls ?? 0)).length,
      };
    };

    // Which build each trial measured. The runner packs `dist/`, so a rebuild
    // between two models of one suite measures two different tools under one
    // comparison — and nothing in the numbers would show it. The runner now
    // refuses to start from an uncommitted tree, but that cannot catch a
    // rebuild BETWEEN runs, so the evidence is surfaced here instead of
    // trusted.
    // `packed_tool_sha256` is the tarball the agent actually ran. Prefer it:
    // `implementation_sha` is the repository HEAD at trial time, which drifts
    // whenever someone commits during a run, and once showed fourteen
    // "builds" for a single model that had measured one tool throughout.
    const builds = [
      ...new Set(records.map((r) => r.packed_tool_sha256 ?? r.implementation_sha).filter(Boolean)),
    ];
    const buildsAreExact = records.every((r) => r.packed_tool_sha256 != null);
    rows.push({
      model,
      family,
      arms,
      builds,
      buildsAreExact,
      dVsA: paired('A', 'D'),
      cVsB: paired('B', 'C'),
    });
  }

  rows.sort((a, b) => a.family.localeCompare(b.family) || a.model.localeCompare(b.model));

  // A comparison across models is only meaningful if every model measured the
  // same tool. Reported per family, because different families are different
  // experiments and are never compared to each other anyway.
  const mixedBuilds = [];
  const unverifiableBuilds = [];
  for (const family of new Set(rows.map((r) => r.family))) {
    const inFamily = rows.filter((r) => r.family === family);
    const all = [...new Set(inFamily.flatMap((r) => r.builds))];
    // Only report a mixed build when it can be stated as a fact. Runs that
    // predate `packed_tool_sha256` fall back to HEAD-at-trial-time, which
    // differs for reasons that have nothing to do with the tool, and crying
    // wolf about those would train a reader to ignore the warning that counts.
    const exact = inFamily.every((r) => r.buildsAreExact);
    if (all.length > 1 && exact) {
      mixedBuilds.push({
        family,
        builds: all,
        byModel: inFamily.map((r) => ({ model: r.model, builds: r.builds })),
      });
    } else if (all.length > 1) {
      unverifiableBuilds.push({ family, distinct: all.length });
    }
  }

  return { rows, skipped, mixedBuilds, unverifiableBuilds };
}
