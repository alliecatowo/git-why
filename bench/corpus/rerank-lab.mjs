#!/usr/bin/env node
/**
 * Offline reranking experiments over already-retrieved results.
 *
 * The rank profile says 40 of 163 gold commits are retrieved inside the top 50
 * but ranked below 5. That is a ranking problem, and ranking problems can be
 * studied without re-running retrieval: dump the top-50 with every signal the
 * response carries, once, then evaluate candidate orderings over the dump.
 *
 * Doing it this way matters for honesty as much as speed. Every variant sees
 * exactly the same candidates, so a difference between them is a difference in
 * ordering and cannot be a difference in what was retrieved that run.
 *
 *   node bench/corpus/rerank-lab.mjs --dump      # collect (slow, once)
 *   node bench/corpus/rerank-lab.mjs             # evaluate (fast, repeatable)
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchWorkSubdir } from '../lib/workdir.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = join(ROOT, 'dist', 'cli', 'main.js');
const DUMP = join(ROOT, 'bench', 'results', 'corpus', 'rerank-dump.json');
const DEPTH = 50;
const MAX_BYTES = 262144;

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};

if (process.argv.includes('--dump')) {
  const repos = arg('repos', benchWorkSubdir('external'));
  const cases = JSON.parse(readFileSync(join(ROOT, 'bench', 'corpus', 'cases.json'), 'utf8')).cases;
  const out = [];
  let done = 0;
  for (const c of cases) {
    const repo = join(repos, c.repositoryId);
    if (!existsSync(join(repo, '.git'))) continue;
    const gold = c.relevantShas ?? [];
    if (gold.length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(
        execFileSync(
          process.execPath,
          [
            CLI,
            c.question,
            '-n',
            String(DEPTH),
            '--no-refresh',
            '--json',
            '--max-bytes',
            String(MAX_BYTES),
          ],
          { cwd: repo, encoding: 'utf8', maxBuffer: 1e9, stdio: ['ignore', 'pipe', 'ignore'] },
        ),
      );
    } catch {
      continue;
    }
    if (parsed.outputTruncated) throw new Error(`truncated on ${c.id}; raise --max-bytes`);
    out.push({
      id: c.id,
      repositoryId: c.repositoryId,
      question: c.question,
      gold,
      results: (parsed.results ?? []).map((r) => ({
        sha: r.sha,
        subject: r.subject,
        rankScore: r.rankScore,
        scores: r.scores,
        matchedBy: r.matchedBy,
        committerTime: r.committerTime,
        messageExcerpt: r.messageExcerpt,
        evidenceCount: (r.evidence ?? []).length,
        evidencePaths: (r.evidence ?? []).map((e) => e.path?.display ?? ''),
      })),
    });
    done += 1;
    if (done % 25 === 0) process.stderr.write(`  ${done}\n`);
  }
  mkdirSync(join(ROOT, 'bench', 'results', 'corpus'), { recursive: true });
  writeFileSync(DUMP, `${JSON.stringify(out)}\n`);
  console.log(`rerank-lab: dumped ${out.length} cases to ${DUMP}`);
  process.exit(0);
}

if (!existsSync(DUMP)) {
  console.error('rerank-lab: no dump. Run with --dump first.');
  process.exit(1);
}
const dump = JSON.parse(readFileSync(DUMP, 'utf8'));

const STOP = new Set(
  'the a an and or of to in on for is was were be been do does did we our us you your i it its that this those these what when why how which who with without from at by as if then than so but not no yes can could should would may might will just also only really actually kind sort thing stuff one two some any all more most much many'.split(
    ' ',
  ),
);
const terms = (q) => [
  ...new Set(
    (q.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w)),
  ),
];

/**
 * Each variant returns a comparable number for a result; higher ranks first.
 * `base` reproduces the shipped order exactly, and is the control.
 */
const VARIANTS = {
  base: (r) => r.rankScore,

  /**
   * A commit matching in several places is stronger evidence than one matching
   * in a single hunk. The shipped collapse takes the best record and discards
   * how many others matched.
   */
  evidenceCount: (r) => r.rankScore * (1 + 0.15 * Math.min(r.evidenceCount, 4)),

  /**
   * A match in the SUBJECT is a claim about the whole commit; a match in a diff
   * hunk may be incidental. The subject is one line an author chose.
   */
  subjectOverlap: (r, c) => {
    const q = terms(c.question);
    if (q.length === 0) return r.rankScore;
    const subject = new Set(terms(r.subject ?? ''));
    const hits = q.filter((t) => subject.has(t)).length;
    return r.rankScore * (1 + 0.5 * (hits / q.length));
  },

  /** Both branches agreeing is stronger than either alone. */
  bothBranches: (r) => r.rankScore * (r.matchedBy?.length >= 2 ? 1.25 : 1),

  /** Overlap against the whole message, not only the subject. */
  messageOverlap: (r, c) => {
    const q = terms(c.question);
    if (q.length === 0) return r.rankScore;
    const body = new Set(terms(`${r.subject ?? ''} ${r.messageExcerpt ?? ''}`));
    const hits = q.filter((t) => body.has(t)).length;
    return r.rankScore * (1 + 0.5 * (hits / q.length));
  },

  /** Subject overlap and branch agreement together. */
  combined: (r, c) => {
    const q = terms(c.question);
    const subject = new Set(terms(r.subject ?? ''));
    const hits = q.length === 0 ? 0 : q.filter((t) => subject.has(t)).length / q.length;
    return r.rankScore * (1 + 0.5 * hits) * (r.matchedBy?.length >= 2 ? 1.25 : 1);
  },
};

/**
 * A deterministic dev/test split, by case id.
 *
 * Every variant below was invented by looking at these cases, so scoring them
 * on the same cases measures how well the guess was tailored to them. Weights
 * are chosen on dev and reported on test, and a variant that only works on dev
 * is discarded rather than explained.
 */
function splitOf(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 2 === 0 ? 'dev' : 'test';
}
const DEV = dump.filter((c) => splitOf(c.id) === 'dev');
const TEST = dump.filter((c) => splitOf(c.id) === 'test');

function evaluate(scoreOf, cases = dump) {
  let hit1 = 0;
  let hit5 = 0;
  let rr = 0;
  for (const c of cases) {
    const gold = new Set(c.gold);
    const ordered = [...c.results].sort((a, b) => scoreOf(b, c) - scoreOf(a, c));
    const idx = ordered.findIndex((r) => gold.has(r.sha));
    if (idx === 0) hit1 += 1;
    if (idx >= 0 && idx < 5) hit5 += 1;
    if (idx >= 0) rr += 1 / (idx + 1);
  }
  const n = cases.length || 1;
  return { hit1: hit1 / n, hit5: hit5 / n, mrr: rr / n };
}

const fmt = (v, b) => {
  const d = v - b;
  const mark = Math.abs(d) < 0.0005 ? '' : d > 0 ? ` (+${d.toFixed(3)})` : ` (${d.toFixed(3)})`;
  return `${v.toFixed(3)}${mark}`;
};

console.log(
  `\n${dump.length} cases (${DEV.length} dev / ${TEST.length} test), reordering the same retrieved top ${DEPTH}\n`,
);

console.log('DEV -- where the variants were chosen. Do not read these as results.\n');
const devBase = evaluate(VARIANTS.base, DEV);
console.log(`${'variant'.padEnd(18)}${'Hit@1'.padEnd(12)}${'Hit@5'.padEnd(12)}MRR`);
for (const [name, fn] of Object.entries(VARIANTS)) {
  const r = evaluate(fn, DEV);
  console.log(
    `${name.padEnd(18)}${fmt(r.hit1, devBase.hit1).padEnd(12)}${fmt(r.hit5, devBase.hit5).padEnd(12)}${fmt(r.mrr, devBase.mrr)}`,
  );
}

// The weight was not derived from anything; sweeping it on dev shows whether
// the variant works or whether one number happened to land well.
console.log('\nmessageOverlap weight sweep, DEV only\n');
console.log(`${'weight'.padEnd(10)}${'Hit@1'.padEnd(12)}${'Hit@5'.padEnd(12)}MRR`);
for (const w of [0, 0.25, 0.5, 0.75, 1, 1.5, 2]) {
  const fn = (r, c) => {
    const q = terms(c.question);
    if (q.length === 0) return r.rankScore;
    const body = new Set(terms(`${r.subject ?? ''} ${r.messageExcerpt ?? ''}`));
    const hits = q.filter((t) => body.has(t)).length;
    return r.rankScore * (1 + w * (hits / q.length));
  };
  const r = evaluate(fn, DEV);
  console.log(
    `${String(w).padEnd(10)}${fmt(r.hit1, devBase.hit1).padEnd(12)}${fmt(r.hit5, devBase.hit5).padEnd(12)}${fmt(r.mrr, devBase.mrr)}`,
  );
}

console.log('\nTEST -- held out. This is the number that counts.\n');
const testBase = evaluate(VARIANTS.base, TEST);
console.log(`${'variant'.padEnd(18)}${'Hit@1'.padEnd(12)}${'Hit@5'.padEnd(12)}MRR`);
for (const [name, fn] of Object.entries(VARIANTS)) {
  const r = evaluate(fn, TEST);
  console.log(
    `${name.padEnd(18)}${fmt(r.hit1, testBase.hit1).padEnd(12)}${fmt(r.hit5, testBase.hit5).padEnd(12)}${fmt(r.mrr, testBase.mrr)}`,
  );
}

// The ceiling: what perfect reordering of these same candidates would give.
const oracle = dump.filter((c) => c.results.some((r) => c.gold.includes(r.sha))).length;
console.log(
  `\nCeiling: ${oracle}/${dump.length} (${((oracle / dump.length) * 100).toFixed(1)}%) of gold commits are somewhere in the top ${DEPTH}.`,
);
console.log('No reordering can exceed that; the rest is a recall problem.\n');
