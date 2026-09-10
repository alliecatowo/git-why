#!/usr/bin/env node
/**
 * Archetype C: the answer lives in a DIFFERENT file than the question.
 *
 * A consumer does something odd -- spreads an array, guards a null, awaits
 * something that looks synchronous -- because a producer somewhere else
 * changed. The commit that explains it never touched the file you are reading,
 * so `git log -- <that file>` cannot surface it no matter how far back you
 * scroll. This is the case structural expansion was built for and has never
 * been measured against.
 *
 * Pairs are extracted mechanically: commit A introduces an exported symbol in
 * file X; a later commit B adapts a call site in file Y != X that references
 * that symbol. The question is asked from the CONSUMER's side, about file Y,
 * and the answer is commit A.
 *
 * The fair competitor is `git log -S<symbol>`, which is what a developer would
 * actually reach for once they had identified the symbol. Path-scoped history
 * (`git log -- Y`) is included because it is the more common first instinct
 * and fails here by construction -- that failure is the point of the archetype,
 * not evidence about Git Why.
 *
 *   node bench/corpus/crossfile.mjs [--repo colinhacks-zod] [--scan 500]
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchWorkSubdir } from '../lib/workdir.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = join(ROOT, 'dist', 'cli', 'main.js');
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const REPO_ID = arg('repo', 'colinhacks-zod');
const SCAN = Number(arg('scan', 500));
const repo = join(benchWorkSubdir('external'), REPO_ID);

function git(args, opts = {}) {
  try {
    return execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 60_000,
      ...opts,
    });
  } catch {
    return '';
  }
}

const SYMBOL_RE =
  /^\+\s*(?:export\s+)?(?:async\s+)?(?:function|const|class|interface|type|def|pub fn|fn)\s+([A-Za-z_][A-Za-z0-9_]{5,})/gm;

/** Commit A introduces a symbol; a later commit B references it from another file. */
function findPairs(limit) {
  const shas = git(['log', '--format=%H', `--max-count=${SCAN}`])
    .split('\n')
    .filter(Boolean);
  const pairs = [];
  for (const sha of shas) {
    if (pairs.length >= limit) break;
    const diff = git(['show', '--format=', '--unified=0', sha]);
    if (diff === '') continue;
    const producerFiles = git(['show', '--format=', '--name-only', sha])
      .split('\n')
      .filter(Boolean);
    if (producerFiles.length === 0 || producerFiles.length > 6) continue;

    const symbols = [...new Set([...diff.matchAll(SYMBOL_RE)].map((m) => m[1]))].filter((sym) => {
      // The symbol must be DISTINCTIVE. Generic names like `schema` or
      // `branch` appear throughout a codebase, so `-S` on them matches
      // coincidental co-occurrence rather than a real producer/consumer
      // relationship. A first pass extracted exactly those and produced
      // nonsense pairs -- "why does api.mdx need schema" -- which measured
      // the extractor, not retrieval.
      if (sym.length < 8) return false;
      if (!/[A-Z_]/.test(sym.slice(1))) return false; // camelCase or snake_case
      const touching = git(['log', '--format=%H', '--max-count=30', `-S${sym}`])
        .split('\n')
        .filter(Boolean).length;
      return touching >= 2 && touching <= 12;
    });
    for (const symbol of symbols.slice(0, 3)) {
      // Later commits that touched this symbol's text.
      const laterShas = git(['log', '--format=%H', `-S${symbol}`, `${sha}..HEAD`])
        .split('\n')
        .filter(Boolean)
        .slice(0, 4);
      for (const later of laterShas) {
        const consumerFiles = git(['show', '--format=', '--name-only', later])
          .split('\n')
          .filter(Boolean);
        // The consumer must be SOURCE. Documentation and changelogs mention
        // symbols without depending on them, so a docs file is not evidence
        // that anything consumes anything.
        const consumer = consumerFiles.find(
          (f) =>
            !producerFiles.includes(f) &&
            /\.(ts|tsx|js|jsx|mjs|cjs|c|h|cc|cpp|rs|go|py)$/.test(f) &&
            !/(^|\/)(docs?|test|tests|__tests__|bench)\//.test(f) &&
            !/\.(test|spec)\./.test(f),
        );
        if (consumer === undefined) continue;

        // The decisive property, checked rather than assumed: the producer
        // commit must NOT appear in the consumer file's own history.
        const consumerHistory = git(['log', '--format=%H', '--', consumer])
          .split('\n')
          .filter(Boolean);
        if (consumerHistory.includes(sha)) continue;

        pairs.push({
          id: `crossfile-${REPO_ID}-${sha.slice(0, 8)}`,
          archetype: 'cross_file_causal',
          repositoryId: REPO_ID,
          symbol,
          producerSha: sha,
          producerFiles: producerFiles.slice(0, 3),
          consumerSha: later,
          consumerFile: consumer,
          producerSubject: git(['log', '-1', '--format=%s', sha]).trim(),
          consumerSubject: git(['log', '-1', '--format=%s', later]).trim(),
        });
        break;
      }
      if (pairs.length >= limit) break;
    }
  }
  return pairs;
}

const pairs = findPairs(Number(arg('limit', 25)));
console.log(`found ${pairs.length} cross-file causal pairs in ${REPO_ID}\n`);

/** The question a developer reading the CONSUMER would ask. */
function questionFor(p) {
  return `why does ${p.consumerFile} need ${p.symbol}`;
}

const strategies = {
  'git log -- <consumer file>': (p) =>
    git(['log', '--format=%H', '--max-count=10', '--', p.consumerFile]).split('\n').filter(Boolean),
  'git log -S<symbol>': (p) =>
    git(['log', '--format=%H', '--max-count=10', `-S${p.symbol}`])
      .split('\n')
      .filter(Boolean),
  'git why': (p) => {
    try {
      const out = execFileSync(
        process.execPath,
        [CLI, questionFor(p), '-n', '10', '--json', '--no-refresh'],
        {
          cwd: repo,
          encoding: 'utf8',
          maxBuffer: 32 * 1024 * 1024,
          timeout: 90_000,
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
      return (JSON.parse(out).results ?? []).map((r) => r.sha);
    } catch {
      return [];
    }
  },
};

const rows = [];
for (const [name, fn] of Object.entries(strategies)) {
  let hit1 = 0;
  let hit10 = 0;
  let n = 0;
  for (const p of pairs) {
    const ranked = fn(p);
    n += 1;
    const i = ranked.indexOf(p.producerSha);
    if (i === 0) hit1 += 1;
    if (i >= 0) hit10 += 1;
  }
  rows.push({ strategy: name, n, hit1: hit1 / n, hit10: hit10 / n });
  console.log(
    `${name.padEnd(28)} n=${n}  Hit@1=${(hit1 / n).toFixed(3)}  Hit@10=${(hit10 / n).toFixed(3)}`,
  );
}

mkdirSync(join(ROOT, 'bench/results/corpus'), { recursive: true });
writeFileSync(
  join(ROOT, 'bench/results/corpus', `crossfile-${REPO_ID}-${Date.now()}.json`),
  `${JSON.stringify({ repo: REPO_ID, pairs: pairs.length, rows, samples: pairs.slice(0, 5) }, null, 2)}\n`,
);

console.log('\nsample pairs:');
for (const p of pairs.slice(0, 3)) {
  console.log(`  asks about : ${p.consumerFile} (${p.symbol})`);
  console.log(`  answer is  : ${p.producerSubject.slice(0, 70)}`);
  console.log(`  in files   : ${p.producerFiles.join(', ').slice(0, 70)}`);
}
