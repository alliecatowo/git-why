#!/usr/bin/env node
/**
 * Compares arms across models, to answer which end of the market this helps.
 *
 * The registered hypothesis (bench/models.json) is that Git Why's benefit is
 * turn and token reduction for CAPABLE models rather than accuracy gain for
 * weak ones. Those imply opposite positioning, so the comparison reports both
 * axes for every model instead of picking one.
 *
 * Everything is PAIRED. Comparing arm medians alone lets task difficulty drive
 * the result: if arm D happened to attempt the easier questions it looks
 * better for a reason that has nothing to do with the treatment. Only tasks
 * where both arms produced a verdict are counted.
 *
 *   node bench/compare-models.mjs [--runs <glob-dir>]
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RESULTS = join(ROOT, 'bench', 'results', 'agents');

function loadRun(dir) {
  const trialsDir = join(dir, 'trials');
  if (!existsSync(trialsDir)) return [];
  return readdirSync(trialsDir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => JSON.parse(readFileSync(join(trialsDir, n), 'utf8')));
}

const median = (xs) => {
  const v = xs.filter((n) => typeof n === 'number' && Number.isFinite(n)).sort((a, b) => a - b);
  return v.length === 0 ? null : v[Math.floor(v.length / 2)];
};
const sum = (xs) => xs.reduce((a, b) => a + (b ?? 0), 0);

/** A trial counts only if it ran to completion and produced a verdict. */
function graded(records, arm) {
  return records.filter(
    (r) =>
      r.arm === arm &&
      !r.invalidation_reason &&
      r.exit_reason === 'completed' &&
      r.evidence_grade &&
      r.evidence_grade.goldSha,
  );
}

const runs = readdirSync(RESULTS)
  .filter((n) => n.startsWith('pilot-'))
  .map((n) => join(RESULTS, n))
  .map((dir) => ({ dir, records: loadRun(dir) }))
  .filter((r) => r.records.length > 0);

// Group by the model actually recorded on the trials, not by directory name.
const byModel = new Map();
for (const { dir, records } of runs) {
  const model = records[0].model_id ?? 'unknown';
  if (!byModel.has(model)) byModel.set(model, { model, dir, records: [] });
  byModel.get(model).records.push(...records);
}

const rows = [];
for (const { model, records } of byModel.values()) {
  const arms = {};
  for (const arm of ['A', 'B', 'C', 'D']) {
    const g = graded(records, arm);
    arms[arm] = {
      n: g.length,
      hits: g.filter((r) => r.evidence_grade.citedGoldSha).length,
      calls: median(g.map((r) => r.tool_calls)),
      inTok: median(g.map((r) => r.input_tokens)),
      outTok: median(g.map((r) => r.output_tokens)),
      // Cost is summed over trials whose token counts RECONCILE against the
      // provider's own database. A trial whose accounting disagrees has an
      // unreliable cost, and averaging it in would quietly corrupt the column
      // that matters most.
      cost: sum(
        g.filter((r) => r.token_cross_check_agrees !== false).map((r) => r.actual_billed_cost),
      ),
      verified: g.filter((r) => r.token_cross_check_agrees === true).length,
      unverified: g.filter((r) => r.token_cross_check_agrees === null).length,
      // Cross-check disagreements invalidate the cost column, so they are
      // surfaced rather than averaged away.
      badTokens: g.filter((r) => r.token_cross_check_agrees === false).length,
    };
  }

  // Paired: only tasks where BOTH arms produced a verdict.
  const paired = (x, y) => {
    const byTask = new Map();
    for (const arm of [x, y]) {
      for (const r of graded(records, arm)) {
        const e = byTask.get(r.task_id) ?? {};
        e[arm] = r;
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

console.log('\nPer-arm, graded trials only (n = trials that ran and produced a verdict)\n');
console.log(
  `${'model'.padEnd(34)}${'arm'.padEnd(5)}${'cited'.padEnd(10)}${'calls'.padEnd(7)}${'in tok'.padEnd(9)}${'cost'.padEnd(11)}${'tok ok'.padEnd(8)}bad-tok`,
);
for (const row of rows) {
  for (const arm of ['A', 'B', 'C', 'D']) {
    const a = row.arms[arm];
    if (a.n === 0) continue;
    console.log(
      `${row.model.slice(0, 33).padEnd(34)}${arm.padEnd(5)}${`${a.hits}/${a.n}`.padEnd(10)}${String(a.calls ?? '-').padEnd(7)}${String(a.inTok ?? '-').padEnd(9)}${`$${a.cost.toFixed(4)}`.padEnd(11)}${`${a.verified}/${a.n}`.padEnd(8)}${a.badTokens || ''}`,
    );
  }
}

console.log('\nPaired D vs A (git why against baseline), same tasks only\n');
console.log(
  `${'model'.padEnd(34)}${'n'.padEnd(5)}${'acc W-L'.padEnd(10)}${'call delta'.padEnd(12)}token delta`,
);
for (const row of rows) {
  const p = row.dVsA;
  if (!p) continue;
  const sign = (v) => (v === null ? '-' : v > 0 ? `+${v}` : String(v));
  console.log(
    `${row.model.slice(0, 33).padEnd(34)}${String(p.n).padEnd(5)}${`${p.accWin}-${p.accLoss}`.padEnd(10)}${sign(p.callsDelta).padEnd(12)}${sign(p.tokDelta)}`,
  );
}

console.log(
  '\n"tok ok" is how many of that arm\'s trials had their token counts confirmed\n' +
    "against the provider's own database. Cost sums only reconciled trials;\n" +
    'runs predating the cross-check show 0 and their cost is unverified.\n',
);

console.log(
  '\nA negative call delta means git why reached the answer in FEWER turns.\n' +
    'The registered prediction is that this grows more negative as models get\n' +
    'more capable, while the accuracy win-loss shrinks toward zero.\n',
);
