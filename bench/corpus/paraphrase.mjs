#!/usr/bin/env node
/**
 * Turns extracted commit bodies into the question a developer would actually
 * ask, in their own words.
 *
 * This step is unavoidable and worth being explicit about. A question quoted
 * from the commit body shares the commit's vocabulary, so `git log --grep`
 * finds it every time -- the leakage gate rejected 100% of quoted candidates,
 * correctly. Real recall is fuzzy: you remember the symptom, not the wording.
 * So the symptom is restated without the original's distinctive terms.
 *
 * Two properties keep this from becoming self-serving:
 *  - The generator sees ONLY the commit body. It never sees Git Why's output,
 *    or which retrieval method will be tested, or the answer's ranking.
 *  - The leakage gate runs AFTER, unchanged. A paraphrase that still hands the
 *    answer to `git log --grep` is discarded regardless of how it was made.
 *
 *   node bench/corpus/paraphrase.mjs [--in <file>] [--batch 12]
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const IN = join(ROOT, arg('in', 'bench/corpus/candidates.json'));
const OUT = join(ROOT, arg('out', 'bench/corpus/paraphrased.json'));
const BATCH = Number(arg('batch', 12));
const MODEL = process.env.BENCH_MODEL ?? 'llmgateway/deepseek-v4-flash';

const INSTRUCTION = [
  'You are given numbered descriptions of software defects, taken from commit messages.',
  '',
  'For each one, write the single question a developer would ask months later when they',
  'half-remember the problem and want to find the commit that dealt with it.',
  '',
  'Rules:',
  '- Describe the SYMPTOM as a user or colleague would experience it. Do not describe the fix.',
  '- Use DIFFERENT words from the input. Avoid its distinctive identifiers, function names,',
  '  flag names and jargon. If the input says "goroutine leak on config reload", ask about',
  '  something like "memory climbing every time we reloaded settings".',
  '- Vague and natural is correct. "what was that bug where..." is the register.',
  '- One line per input. No numbering in your answer, no commentary, no code.',
  '- Output exactly one line per input, in order.',
].join('\n');

const data = JSON.parse(readFileSync(IN, 'utf8'));
const cases = data.cases ?? data;
const out = [];

const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');

for (let i = 0; i < cases.length; i += BATCH) {
  const batch = cases.slice(i, i + BATCH);
  const prompt = `${INSTRUCTION}\n\n${batch
    .map((c, n) => `${n + 1}. ${c.question.replace(/\s+/g, ' ').slice(0, 400)}`)
    .join('\n')}`;
  let text = '';
  try {
    text = execFileSync('opencode', ['run', '--model', MODEL, prompt], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 180_000,
    });
  } catch (err) {
    console.error(`[batch ${i}] generation failed: ${String(err.message).slice(0, 120)}`);
    continue;
  }
  const lines = text
    .replace(ANSI, '')
    .split('\n')
    .map((l) => l.replace(/^\s*\d+[.)]\s*/, '').trim())
    .filter((l) => l.length > 25 && !l.startsWith('>') && !/^build\b/i.test(l));

  for (let j = 0; j < batch.length && j < lines.length; j += 1) {
    out.push({ ...batch[j], question: lines[j], originalSentence: batch[j].question });
  }
  console.log(`[paraphrase] ${Math.min(i + BATCH, cases.length)}/${cases.length}`);
}

writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      model: MODEL,
      note: 'Questions restated from commit bodies by a model that saw only the body -- never Git Why output, never a ranking. The leakage gate is applied afterwards and is unchanged.',
      cases: out,
    },
    null,
    2,
  )}\n`,
);
console.log(`\nwrote ${out.length} paraphrased cases`);
