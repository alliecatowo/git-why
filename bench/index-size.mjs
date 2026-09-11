#!/usr/bin/env node
/**
 * Measures index size per record across the pinned real clones.
 *
 * This existed as a hand-written JSON file transcribed from prose in
 * docs/indexes.md, and the curl row had drifted: the file said 1.00 GiB where
 * the index on disk was 1.37 GiB. A number nothing regenerates is a number
 * that is true once.
 *
 * `diskBytes` and `recordCount` come from `git why status --json`, which is
 * the tool's own accounting, so the ratio is not computed from two different
 * sources that could disagree.
 *
 *   node bench/index-size.mjs [--repos <dir>]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchWorkSubdir } from './lib/workdir.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'dist', 'cli', 'main.js');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const reposDir = resolve(arg('repos', benchWorkSubdir('external')));
const outFile = join(ROOT, 'bench', 'results', 'index-size.json');

if (!existsSync(CLI)) {
  console.error(`index-size: no CLI at ${CLI}. Run npm run build first.`);
  process.exit(1);
}
if (!existsSync(reposDir)) {
  console.error(`index-size: no clones at ${reposDir}.`);
  process.exit(1);
}

const rows = [];
const skipped = [];
for (const name of readdirSync(reposDir).sort()) {
  const repo = join(reposDir, name);
  if (!existsSync(join(repo, '.git'))) continue;
  let status;
  try {
    status = JSON.parse(
      execFileSync(process.execPath, [CLI, 'status', '--json'], {
        cwd: repo,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 1e8,
      }),
    ).index;
  } catch (err) {
    skipped.push({ repo: name, reason: err.message.split('\n')[0] });
    continue;
  }
  // An index that is not current would report a size for a different corpus
  // than the commit count beside it, so the ratio would be meaningless.
  if (status?.state !== 'current' || status.diskBytes == null || !status.recordCount) {
    skipped.push({ repo: name, reason: `index state is ${status?.state ?? 'unknown'}` });
    continue;
  }
  rows.push({
    repo: name,
    commits: status.indexedCommits,
    records: status.recordCount,
    diskBytes: status.diskBytes,
    kbPerRecord: Number((status.diskBytes / status.recordCount / 1024).toFixed(2)),
  });
}

rows.sort((a, b) => b.commits - a.commits);
const out = {
  note: "Measured from `git why status --json` in each pinned clone: diskBytes and recordCount come from the tool's own accounting, so the ratio cannot be assembled from two disagreeing sources. Regenerate with `node bench/index-size.mjs`.",
  measuredAt: new Date().toISOString(),
  repos: rows,
  skipped,
};
writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`);

const gib = (b) => `${(b / 1024 ** 3).toFixed(2)} GiB`;
console.log(`index-size: ${rows.length} repositories, ${skipped.length} skipped\n`);
for (const r of rows) {
  console.log(
    `  ${r.repo.padEnd(20)} ${String(r.commits).padStart(6)} commits  ${String(r.records).padStart(7)} records  ${gib(r.diskBytes).padStart(9)}  ${r.kbPerRecord} KB/record`,
  );
}
for (const s of skipped) console.log(`  skipped ${s.repo}: ${s.reason}`);
console.log(`\nwrote ${outFile}`);
