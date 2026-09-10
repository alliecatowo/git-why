#!/usr/bin/env node
/**
 * Measures the ceiling of query restatement before any interface is built on
 * the idea.
 *
 * The diagnostic result is that indexing is perfect (querying a commit with
 * its own subject retrieves it at recall@20 of 1.000) while the paraphrased
 * question retrieves it at 0.280. The whole deficit is the jump from how a
 * person asks to how a commit is written.
 *
 * The obvious fix is to have the CALLER restate the question in the vocabulary
 * a codebase would use, which is what an MCP tool description or a plugin
 * skill can instruct a model to do. Before building that, this measures how
 * much of the gap restatement actually recovers. If it recovers little, the
 * interface work is not worth doing and the ceiling is lower than 1.000
 * suggests.
 *
 * The restater is given the question and the repository's name and nothing
 * else. It never sees the answer, the candidate commits, or any ranking --
 * exactly the information an agent would hold before searching. That makes
 * this a conservative estimate: a real agent could also read the code first.
 *
 *   node bench/corpus/restate.mjs [--repo colinhacks-zod] [--batch 10]
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchWorkSubdir } from '../lib/workdir.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = join(ROOT, 'dist', 'cli', 'main.js');
const REPOS = benchWorkSubdir('external');
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const ONLY = arg('repo', 'colinhacks-zod');
const BATCH = Number(arg('batch', 10));
const MODEL = process.env.BENCH_MODEL ?? 'llmgateway/deepseek-v4-flash';

const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');

function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 180_000,
      ...opts,
    });
  } catch {
    return '';
  }
}

const INSTRUCTION = [
  "You are helping search a software project's COMMIT HISTORY.",
  '',
  'Each numbered line is how a developer phrased a question from memory. Commit',
  "messages do not use that phrasing -- they use the codebase's own technical",
  'vocabulary, and they describe the change that was made rather than the symptom.',
  '',
  'Rewrite each question as the search query most likely to match the commit that',
  'addressed it.',
  '',
  'Rules:',
  '- Use the technical terms an engineer would have written in the commit message.',
  '- Prefer the language of the CHANGE (what was done) over the SYMPTOM (what was seen).',
  '- Keep identifiers, API names and subsystem names if the question implies them.',
  '- No question marks, no prose framing. A search query, not a sentence.',
  '- One line per input, in order. No numbering, no commentary.',
].join('\n');

const all = JSON.parse(readFileSync(join(ROOT, 'bench/corpus/cases.json'), 'utf8')).cases;
const cases = all.filter((c) => c.repositoryId === ONLY);
const repoDir = join(REPOS, ONLY);

const restated = [];
for (let i = 0; i < cases.length; i += BATCH) {
  const batch = cases.slice(i, i + BATCH);
  const prompt = `${INSTRUCTION}\n\nProject: ${ONLY}\n\n${batch
    .map((c, n) => `${n + 1}. ${c.question}`)
    .join('\n')}`;
  const text = run('opencode', ['run', '--model', MODEL, prompt]);
  const lines = text
    .replace(ANSI, '')
    .split('\n')
    .map((l) => l.replace(/^\s*\d+[.)]\s*/, '').trim())
    .filter((l) => l.length > 8 && !l.startsWith('>') && !/^build\b/i.test(l));
  for (let j = 0; j < batch.length && j < lines.length; j += 1) {
    restated.push({ ...batch[j], restated: lines[j] });
  }
  console.log(`[restate] ${Math.min(i + BATCH, cases.length)}/${cases.length}`);
}

/** recall/precision for one phrasing of the questions. */
function score(getQuery, label) {
  let h1 = 0;
  let h5 = 0;
  let r20 = 0;
  let rr = 0;
  let n = 0;
  for (const c of restated) {
    const out = run(process.execPath, [CLI, getQuery(c), '-n', '20', '--json', '--no-refresh'], {
      cwd: repoDir,
    });
    let res = [];
    try {
      res = JSON.parse(out).results ?? [];
    } catch {
      continue;
    }
    n += 1;
    const i = res.findIndex((r) => r.sha === c.relevantShas[0]);
    if (i === 0) h1 += 1;
    if (i >= 0 && i < 5) h5 += 1;
    if (i >= 0) r20 += 1;
    if (i >= 0) rr += 1 / (i + 1);
  }
  console.log(
    `${label.padEnd(26)} n=${n}  Hit@1=${(h1 / n).toFixed(3)}  Hit@5=${(h5 / n).toFixed(3)}  MRR=${(rr / n).toFixed(3)}  recall@20=${(r20 / n).toFixed(3)}`,
  );
  return { label, n, hit1: h1 / n, hit5: h5 / n, mrr: rr / n, recall20: r20 / n };
}

console.log('');
const rows = [
  score((c) => c.question, 'as asked'),
  score((c) => c.restated, 'restated by the caller'),
];

writeFileSync(
  join(ROOT, 'bench/results/corpus', `restate-${ONLY}-${Date.now()}.json`),
  `${JSON.stringify({ repo: ONLY, model: MODEL, rows, samples: restated.slice(0, 5) }, null, 2)}\n`,
);
console.log('\nsample restatements:');
for (const c of restated.slice(0, 3)) {
  console.log(`  asked   : ${c.question.slice(0, 90)}`);
  console.log(`  restated: ${c.restated.slice(0, 90)}`);
}
