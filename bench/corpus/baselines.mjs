#!/usr/bin/env node
/**
 * Runs Git Why against the tools a developer would actually reach for.
 *
 * The agent pilots compared Git Why to "an agent with no retrieval tooling",
 * which is a strawman: nobody answers a history question with nothing. The
 * honest competitors are the commands people type, and `zg` for the current
 * code. If Git Why cannot beat `git log --grep` on questions you cannot grep
 * for, it has no reason to exist.
 *
 * This benchmark needs no model and costs nothing, so it can run at high N and
 * be re-run after every change. That is deliberate: the expensive agent
 * benchmark should confirm a result, not discover it.
 *
 *   node bench/corpus/baselines.mjs [--cases <file>] [--repos <dir>] [--limit N]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
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
const CASES = join(ROOT, arg('cases', 'bench/corpus/cases.json'));
const REPOS = arg('repos', benchWorkSubdir('external'));
const LIMIT = Number(arg('limit', 0));
const TOPK = 5;

function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, {
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

const STOP = new Set(
  (
    'the a an and or but for with that this from into when what which why how does do did is are was were be ' +
    'been being have has had will would should could can may might must not no yes if then else than there ' +
    'their they them it its our we you your i me my used using still able only ever after before some'
  ).split(/\s+/),
);
const terms = (t) => [
  ...new Set((t.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? []).filter((w) => !STOP.has(w))),
];

/** Each strategy returns a ranked list of SHAs, best first. */
const STRATEGIES = {
  /** What someone types first: keyword search over commit messages. */
  'git log --grep': (repo, q) => {
    const args = ['log', '--format=%H', '-i', `--max-count=${TOPK}`];
    for (const w of terms(q).slice(0, 6)) args.push(`--grep=${w}`);
    return run('git', ['-C', repo, ...args])
      .split('\n')
      .filter(Boolean);
  },

  /** The stricter form, when the loose one returns noise. */
  'git log --grep --all-match': (repo, q) => {
    const words = terms(q).slice(0, 3);
    if (words.length === 0) return [];
    const args = ['log', '--format=%H', '-i', '--all-match', `--max-count=${TOPK}`];
    for (const w of words) args.push(`--grep=${w}`);
    return run('git', ['-C', repo, ...args])
      .split('\n')
      .filter(Boolean);
  },

  /** Pickaxe on the rarest content word: finds commits that touched it. */
  'git log -S': (repo, q) => {
    const words = [...terms(q)].sort((a, b) => b.length - a.length).slice(0, 1);
    if (words.length === 0) return [];
    return run('git', ['-C', repo, 'log', '--format=%H', `--max-count=${TOPK}`, `-S${words[0]}`])
      .split('\n')
      .filter(Boolean);
  },

  /** Regex pickaxe over diffs. */
  'git log -G': (repo, q) => {
    const words = [...terms(q)].sort((a, b) => b.length - a.length).slice(0, 1);
    if (words.length === 0) return [];
    return run('git', ['-C', repo, 'log', '--format=%H', `--max-count=${TOPK}`, `-G${words[0]}`])
      .split('\n')
      .filter(Boolean);
  },

  /** Semantic search over CURRENT code, then history of whatever it points at. */
  zg: (repo, q) => {
    // zg has no --path-only; its default output is agent markdown with paths
    // in it. Parse those, then ask git for each file's recent history -- which
    // is the realistic workflow: semantic search over CURRENT code, then log
    // whatever it points at.
    const raw = run('zg', ['query', q, '--limit', '3', '--refresh', 'off'], { cwd: repo });
    const hits = [
      ...new Set(
        (raw.match(/(?:^|[\s`(])([\w./-]+\.[A-Za-z]{1,5})(?::\d+)?/gm) ?? [])
          .map((m) => m.replace(/^[\s`(]/, '').split(':')[0])
          .filter((p) => p.includes('/') || p.includes('.')),
      ),
    ].slice(0, 3);
    const shas = [];
    for (const path of hits) {
      const log = run('git', ['-C', repo, 'log', '--format=%H', '--max-count=2', '--', path]);
      for (const sha of log.split('\n').filter(Boolean)) if (!shas.includes(sha)) shas.push(sha);
    }
    return shas.slice(0, TOPK);
  },

  'git why': (repo, q) => {
    const out = run(process.execPath, [CLI, q, '-n', String(TOPK), '--json', '--no-refresh'], {
      cwd: repo,
    });
    try {
      return (JSON.parse(out).results ?? []).map((r) => r.sha);
    } catch {
      return [];
    }
  },
};

const data = JSON.parse(readFileSync(CASES, 'utf8'));
let cases = data.cases ?? data;
if (LIMIT > 0) cases = cases.slice(0, LIMIT);

const scores = {};
for (const name of Object.keys(STRATEGIES)) {
  scores[name] = { n: 0, hit1: 0, hit5: 0, rr: 0, empty: 0 };
}

let done = 0;
for (const c of cases) {
  const repo = join(REPOS, c.repositoryId);
  if (!existsSync(join(repo, '.git'))) continue;
  const gold = new Set(c.relevantShas);
  for (const [name, fn] of Object.entries(STRATEGIES)) {
    const ranked = fn(repo, c.question);
    const s = scores[name];
    s.n += 1;
    if (ranked.length === 0) s.empty += 1;
    const idx = ranked.findIndex((sha) => gold.has(sha));
    if (idx === 0) s.hit1 += 1;
    if (idx >= 0 && idx < TOPK) s.hit5 += 1;
    if (idx >= 0) s.rr += 1 / (idx + 1);
  }
  done += 1;
  if (done % 10 === 0) console.log(`[baselines] ${done}/${cases.length}`);
}

const rows = Object.entries(scores).map(([name, s]) => ({
  strategy: name,
  n: s.n,
  hit1: s.n ? s.hit1 / s.n : null,
  hit5: s.n ? s.hit5 / s.n : null,
  mrr: s.n ? s.rr / s.n : null,
  returnedNothing: s.empty,
}));
rows.sort((a, b) => (b.mrr ?? 0) - (a.mrr ?? 0));

const outDir = join(ROOT, 'bench', 'results', 'corpus');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(outPath, `${JSON.stringify({ cases: cases.length, rows }, null, 2)}\n`);

console.log('');
console.table(
  rows.map((r) => ({
    strategy: r.strategy,
    n: r.n,
    'Hit@1': r.hit1 === null ? '-' : r.hit1.toFixed(3),
    'Hit@5': r.hit5 === null ? '-' : r.hit5.toFixed(3),
    MRR: r.mrr === null ? '-' : r.mrr.toFixed(3),
    empty: r.returnedNothing,
  })),
);
console.log(`\nwrote ${outPath}`);
