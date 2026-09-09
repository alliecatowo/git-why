// Commit-level retrieval metrics with correct denominators. Shared between
// bench/retrieval/run.mjs (which produces per-query records) and
// bench/report.mjs (which aggregates saved records into tables).

/**
 * @param {string[]} rankedShas ranked commit SHAs actually returned, best first
 * @param {string[]} relevantShas ALL relevant SHAs for this case (may be >1)
 */
export function scoreCase(rankedShas, relevantShas) {
  const relevant = new Set(relevantShas);
  if (relevant.size === 0) {
    // No-evidence case: Hit/Recall/MRR are undefined, not zero. Callers must
    // exclude these from averaged metrics and report them separately.
    return { applicable: false, hit1: null, hit3: null, hit5: null, recall5: null, mrr: null };
  }
  const top1 = rankedShas.slice(0, 1);
  const top3 = rankedShas.slice(0, 3);
  const top5 = rankedShas.slice(0, 5);
  const hit1 = top1.some((s) => relevant.has(s));
  const hit3 = top3.some((s) => relevant.has(s));
  const hit5 = top5.some((s) => relevant.has(s));
  const foundInTop5 = top5.filter((s) => relevant.has(s)).length;
  // Correct denominator: recall of EVERY relevant commit, not "at least one".
  const recall5 = foundInTop5 / relevant.size;
  let mrr = 0;
  for (let i = 0; i < rankedShas.length; i++) {
    if (relevant.has(rankedShas[i])) {
      mrr = 1 / (i + 1);
      break;
    }
  }
  return { applicable: true, hit1, hit3, hit5, recall5, mrr };
}

/** Aggregate a list of scoreCase() results, ignoring inapplicable (no-evidence) ones. */
export function aggregate(scored) {
  const applicable = scored.filter((s) => s.applicable);
  const n = applicable.length;
  const mean = (key) => (n === 0 ? null : applicable.reduce((a, s) => a + (s[key] ? 1 : 0), 0) / n);
  const meanNumeric = (key) => (n === 0 ? null : applicable.reduce((a, s) => a + s[key], 0) / n);
  return {
    n,
    hit1: mean('hit1'),
    hit3: mean('hit3'),
    hit5: mean('hit5'),
    recall5: n === 0 ? null : applicable.reduce((a, s) => a + s.recall5, 0) / n,
    mrr: meanNumeric('mrr'),
  };
}
