#!/usr/bin/env node
/**
 * Console view of the cross-model comparison, for use while tiers are running.
 *
 * The registered hypothesis (bench/models.json) is that Git Why's benefit is
 * turn and token reduction for CAPABLE models rather than accuracy gain for
 * weak ones. Those imply opposite positioning, so both axes are reported for
 * every model instead of picking one.
 *
 * All the arithmetic lives in bench/agents/model-compare.mjs, shared with
 * bench/report.mjs so the console and the published document cannot disagree.
 *
 *   node bench/compare-models.mjs
 */

import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { compareModels, ARMS } from './agents/model-compare.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { rows, skipped, mixedBuilds, unverifiableBuilds } = compareModels(
  join(ROOT, 'bench', 'results', 'agents'),
);

const families = [...new Set(rows.map((r) => r.family))];
console.log(
  `\nTask families present: ${families.join(', ')}. ` +
    'Briefs are six questions scored 0..6; lookups are one question, pass/fail.\n' +
    'They are never pooled -- averaging a score into a bit would report one number for two measurements.\n',
);

console.log('\nPer-arm, graded trials only (n = trials that ran and produced a verdict)\n');
console.log(
  `${'family'.padEnd(8)}${'model'.padEnd(34)}${'arm'.padEnd(5)}${'score'.padEnd(10)}${'calls'.padEnd(7)}${'in tok'.padEnd(9)}${'cost'.padEnd(11)}${'tok ok'.padEnd(8)}bad-tok`,
);
for (const row of rows) {
  for (const arm of ARMS) {
    const a = row.arms[arm];
    if (a.n === 0) continue;
    console.log(
      `${row.family.padEnd(8)}${row.model.slice(0, 33).padEnd(34)}${arm.padEnd(5)}${`${a.points}/${a.pointsOutOf}`.padEnd(10)}${String(a.calls ?? '-').padEnd(7)}${String(a.inTok ?? '-').padEnd(9)}${`$${a.cost.toFixed(4)}`.padEnd(11)}${`${a.verified}/${a.n}`.padEnd(8)}${a.badTokens || ''}`,
    );
  }
}

console.log('\nPaired D vs A (git why against baseline), same tasks only\n');
console.log(
  `${'family'.padEnd(8)}${'model'.padEnd(34)}${'n'.padEnd(5)}${'points A>D'.padEnd(14)}${'W-L'.padEnd(8)}${'call delta'.padEnd(12)}${'calls -/+'.padEnd(11)}token delta`,
);
for (const row of rows) {
  const p = row.dVsA;
  if (!p) continue;
  const sign = (v) => (v === null ? '-' : v > 0 ? `+${v}` : String(v));
  console.log(
    `${row.family.padEnd(8)}${row.model.slice(0, 33).padEnd(34)}${String(p.n).padEnd(5)}${(p.pointsOutOf === null ? '-' : `${p.pointsX}->${p.pointsY}/${p.pointsOutOf}`).padEnd(14)}${`${p.accWin}-${p.accLoss}`.padEnd(8)}${sign(p.callsDelta).padEnd(12)}${`${p.callsCheaper}/${p.callsDearer}`.padEnd(11)}${sign(p.tokDelta)}`,
  );
}

for (const mixed of mixedBuilds) {
  console.log(
    `\n!! ${mixed.family} trials span ${mixed.builds.length} builds, so these models did not all\n` +
      '   measure the same tool and cannot be compared to each other:\n',
  );
  for (const m of mixed.byModel) {
    console.log(`     ${m.model.padEnd(34)}${m.builds.map((b) => b.slice(0, 8)).join(' ')}`);
  }
  console.log('   Re-run the affected models against one commit.\n');
}

for (const u of unverifiableBuilds) {
  console.log(
    `\nNote: ${u.family} trials predate per-run tool hashing, so which build each measured\n` +
      `cannot be established (${u.distinct} distinct repository HEADs, which is not the same thing).\n`,
  );
}

if (skipped.length > 0) {
  console.log(
    `\nExcluded ${skipped.length} run(s) still in flight (no summary.json): ` +
      skipped.map((s) => s.split('/').pop()).join(', '),
  );
}

console.log(
  '\n"tok ok" is how many of that arm\'s trials had their token counts confirmed\n' +
    "against the provider's own database. Cost sums only reconciled trials;\n" +
    'runs predating the cross-check show 0 and their cost is unverified.\n',
);

console.log(
  'A negative call delta means git why reached the answer in FEWER turns.\n' +
    'The registered prediction is that this grows more negative as models get\n' +
    'more capable, while the accuracy win-loss shrinks toward zero.\n',
);
