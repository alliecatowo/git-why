#!/usr/bin/env node
/**
 * Why are 42% of gold commits never retrieved?
 *
 * "The embedding cannot bridge the vocabulary gap" is the assumed answer, and
 * it is the expensive one to fix. Before believing it, rule out the cheap
 * explanations, because they call for completely different work:
 *
 *   not indexed    a coverage bug -- the commit is not in the corpus at all
 *   not findable   indexed, but not retrievable even by its OWN words
 *   semantic gap   findable by its own words, not by a paraphrase
 *
 * Only the third is the embedding's fault. The first is a bug and the second
 * would point at tokenization or filtering rather than at the model.
 *
 * The probe: ask for the commit using its own subject line. If that does not
 * retrieve it, no paraphrase ever will, and the problem is upstream of
 * meaning.
 *
 *   node bench/corpus/recall-probe.mjs [--limit N]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchWorkSubdir } from '../lib/workdir.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = join(ROOT, 'dist', 'cli', 'main.js');
const MAX_BYTES = 262144;
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const repos = arg('repos', benchWorkSubdir('external'));
const limit = Number(arg('limit', 0));

const profile = JSON.parse(
  readFileSync(join(ROOT, 'bench', 'results', 'corpus', 'rank-profile.json'), 'utf8'),
);
const cases = JSON.parse(readFileSync(join(ROOT, 'bench', 'corpus', 'cases.json'), 'utf8')).cases;
const byId = new Map(cases.map((c) => [c.id, c]));

const missing = profile.rows.filter((r) => r.rank === null);
const selected = limit > 0 ? missing.slice(0, limit) : missing;

function search(repo, query, depth) {
  try {
    const out = execFileSync(
      process.execPath,
      [CLI, query, '-n', String(depth), '--no-refresh', '--json', '--max-bytes', String(MAX_BYTES)],
      { cwd: repo, encoding: 'utf8', maxBuffer: 1e9, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const parsed = JSON.parse(out);
    if (parsed.outputTruncated) throw new Error('truncated');
    return (parsed.results ?? []).map((r) => r.sha);
  } catch {
    return null;
  }
}

const verdicts = { notIndexed: [], notFindable: [], semanticGap: [], probeFailed: [] };
let done = 0;
for (const row of selected) {
  const c = byId.get(row.id);
  if (c === undefined) continue;
  const repo = join(repos, c.repositoryId);
  if (!existsSync(join(repo, '.git'))) continue;
  const gold = (c.relevantShas ?? [])[0];
  if (!gold) continue;

  // Is it in the repository's history at all? A gold commit that is not
  // reachable is a corpus fault, not a retrieval one.
  let subject;
  try {
    subject = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%s', gold], {
      encoding: 'utf8',
    }).trim();
  } catch {
    verdicts.notIndexed.push({ id: c.id, reason: 'commit not in repository' });
    continue;
  }

  // Its own subject, searched literally. If the index holds this commit, the
  // full-text branch cannot reasonably miss it.
  const byOwnWords = search(repo, subject, 20);
  if (byOwnWords === null) {
    verdicts.probeFailed.push({ id: c.id });
  } else if (!byOwnWords.includes(gold)) {
    verdicts.notFindable.push({ id: c.id, subject, repositoryId: c.repositoryId });
  } else {
    verdicts.semanticGap.push({
      id: c.id,
      subject,
      question: c.question,
      rankByOwnWords: byOwnWords.indexOf(gold) + 1,
    });
  }
  done += 1;
  if (done % 20 === 0) process.stderr.write(`  ${done}/${selected.length}\n`);
}

const total = selected.length;
const pct = (n) => `${((n / total) * 100).toFixed(1)}%`;
console.log(`\n${total} gold commits that retrieval never returned for their question\n`);
console.log(
  `  not in the repository   ${String(verdicts.notIndexed.length).padStart(4)}  ${pct(verdicts.notIndexed.length)}`,
);
console.log(
  `  indexed but unfindable  ${String(verdicts.notFindable.length).padStart(4)}  ${pct(verdicts.notFindable.length)}   <- NOT the embedding`,
);
console.log(
  `  genuine semantic gap    ${String(verdicts.semanticGap.length).padStart(4)}  ${pct(verdicts.semanticGap.length)}   <- the embedding`,
);
console.log(
  `  probe failed            ${String(verdicts.probeFailed.length).padStart(4)}  ${pct(verdicts.probeFailed.length)}`,
);

if (verdicts.notFindable.length > 0) {
  console.log('\nUnfindable by their own subject (the actionable ones):\n');
  for (const v of verdicts.notFindable.slice(0, 12)) {
    console.log(`  [${v.repositoryId}] ${v.subject.slice(0, 88)}`);
  }
}

const out = join(ROOT, 'bench', 'results', 'corpus', 'recall-probe.json');
writeFileSync(out, `${JSON.stringify({ total, verdicts }, null, 2)}\n`);
console.log(`\nwrote ${out}`);
