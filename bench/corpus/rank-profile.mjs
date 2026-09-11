#!/usr/bin/env node
/**
 * Where does the right commit actually rank?
 *
 * Hit@5 says how often it is in the top five and nothing about the rest. That
 * is the wrong shape for deciding what to fix: a gold commit sitting at rank 7
 * and one that never appears at all are the same miss by that measure, and
 * they call for opposite work. Rank 7 is a ranking problem, fixable by
 * reordering what retrieval already found. Absent is a recall problem, and no
 * amount of reranking will help.
 *
 * This asks for a deep result list and records the gold commit's position, so
 * the misses can be split into "found but ranked badly" and "never retrieved".
 *
 *   node bench/corpus/rank-profile.mjs [--depth 100] [--limit N]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchWorkSubdir } from '../lib/workdir.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = join(ROOT, 'dist', 'cli', 'main.js');
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const depth = Number(arg('depth', 50));
const limit = Number(arg('limit', 0));
const repos = arg('repos', benchWorkSubdir('external'));
const outFile = join(ROOT, 'bench', 'results', 'corpus', 'rank-profile.json');
/** The documented maximum, so a deep list is never clipped by the byte budget. */
const MAX_BYTES = 262144;

const cases = JSON.parse(readFileSync(join(ROOT, 'bench', 'corpus', 'cases.json'), 'utf8')).cases;
const selected = limit > 0 ? cases.slice(0, limit) : cases;

/**
 * `--max-bytes` defaults to 16 KiB, and fifty results with evidence do not fit
 * in it. The CLI says so — `outputTruncated: true` and a warning — but an
 * earlier version of this script asked for fifty, silently received seventeen,
 * and reported that no gold commit ever ranks between 21 and 50. That was a
 * property of the byte budget, not of retrieval.
 *
 * So the budget is raised to fit, and a truncated response is refused rather
 * than measured.
 */
function ranked(repo, question) {
  try {
    const out = execFileSync(
      process.execPath,
      [
        CLI,
        '--query',
        question,
        '-n',
        String(depth),
        '--no-refresh',
        '--json',
        '--max-bytes',
        String(MAX_BYTES),
      ],
      { cwd: repo, encoding: 'utf8', maxBuffer: 1e9, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const parsed = JSON.parse(out);
    if (parsed.outputTruncated) {
      throw new Error(
        `response truncated at --max-bytes=${MAX_BYTES}; raise it rather than measuring a clipped list`,
      );
    }
    return { shas: (parsed.results ?? []).map((r) => r.sha), truncated: false };
  } catch (err) {
    if (err instanceof Error && /truncated/.test(err.message)) throw err;
    return null;
  }
}

const rows = [];
let done = 0;
for (const c of selected) {
  const repo = join(repos, c.repositoryId);
  if (!existsSync(join(repo, '.git'))) continue;
  const gold = new Set(c.relevantShas ?? []);
  if (gold.size === 0) continue;
  const result = ranked(repo, c.question);
  if (result === null) continue;
  const idx = result.shas.findIndex((sha) => gold.has(sha));
  rows.push({
    id: c.id,
    repositoryId: c.repositoryId,
    rank: idx < 0 ? null : idx + 1,
    returned: result.shas.length,
  });
  done += 1;
  if (done % 25 === 0) process.stderr.write(`  ${done}/${selected.length}\n`);
}

const found = rows.filter((r) => r.rank !== null);
const bucket = (lo, hi) => found.filter((r) => r.rank >= lo && r.rank <= hi).length;
const profile = {
  depth,
  cases: rows.length,
  foundWithinDepth: found.length,
  neverRetrieved: rows.length - found.length,
  buckets: {
    1: bucket(1, 1),
    '2-5': bucket(2, 5),
    '6-10': bucket(6, 10),
    '11-20': bucket(11, 20),
    '21-50': bucket(21, 50),
    [`51-${depth}`]: bucket(51, depth),
  },
  rows,
};

mkdirSync(join(ROOT, 'bench', 'results', 'corpus'), { recursive: true });
writeFileSync(outFile, `${JSON.stringify(profile, null, 2)}\n`);

const pct = (n) => `${((n / profile.cases) * 100).toFixed(1)}%`;
console.log(`\n${profile.cases} cases, asking for the top ${depth}\n`);
for (const [k, v] of Object.entries(profile.buckets)) {
  console.log(`  rank ${k.padEnd(8)} ${String(v).padStart(4)}  ${pct(v)}`);
}
console.log(
  `  never found  ${String(profile.neverRetrieved).padStart(4)}  ${pct(profile.neverRetrieved)}`,
);
console.log(`\nOf the ${profile.cases - bucket(1, 5)} misses at Hit@5:`);
const rerankable = profile.cases - bucket(1, 5) - profile.neverRetrieved;
console.log(`  ${rerankable} are retrieved but ranked below 5  -> a RANKING problem`);
console.log(`  ${profile.neverRetrieved} are never retrieved at all  -> a RECALL problem`);
console.log(`\nwrote ${outFile}`);
