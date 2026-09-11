#!/usr/bin/env node
/**
 * Records asciinema casts of REAL sessions for the documentation site.
 *
 * These are recordings, not reconstructions. Every frame is a command actually
 * executing against a real repository, so the timings are real latency and the
 * output is whatever the tool actually printed. A hand-written "terminal" that
 * shows invented output is a claim dressed as a demonstration, and this project
 * has spent a lot of effort not making claims it has not measured.
 *
 *   node scripts/record-casts.mjs [--repo <dir>]
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'site', 'public', 'casts');
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const REPO = arg('repo', join(ROOT, '..', '..', '.cache'));

/** One cast per scenario, so a page can embed exactly the one it is about. */
const SCENARIOS = [
  {
    name: 'ask',
    title: 'Asking a question you cannot grep for',
    repo: arg('zod', '/Users/allie/.cache/git-why-bench/0199f07e4778/external/colinhacks-zod'),
    script: ['git why "why did making lots of schemas suddenly get slow and memory-hungry"'],
  },
  {
    name: 'owners',
    title: 'Who established an area',
    repo: arg('curl', '/Users/allie/.cache/git-why-bench/0199f07e4778/external/curl-curl'),
    script: ['git why "TLS backend abstraction and vtls layer" --owners -n 20'],
  },
  {
    name: 'first',
    title: 'When something was first introduced',
    repo: arg('curl', '/Users/allie/.cache/git-why-bench/0199f07e4778/external/curl-curl'),
    script: ['git why "when was HTTP/3 support first introduced" --first'],
  },
  {
    // An AGENT session, not a human one. This is the case the plugin exists
    // for, and showing a person typing the command does not demonstrate it:
    // what matters is whether a model REACHES for history unprompted and uses
    // what comes back. Recorded live, so a run where the agent ignores the
    // tool would show that instead.
    name: 'agent',
    title: 'An agent investigating why code is the way it is',
    repo: arg('zod', '/Users/allie/.cache/git-why-bench/0199f07e4778/external/colinhacks-zod'),
    agent: true,
    // The agent is given the SKILL, because that is what the plugin supplies.
    // A first recording that merely mentioned the tool produced a session where
    // the agent ignored it and answered from GitHub issue data -- honest, but a
    // demonstration of nothing. Routing guidance is the product, so the demo
    // includes it.
    //
    // No backticks in the prompt: sh performs command substitution on them even
    // inside double quotes, and an earlier recording was just shell errors.
    script: [
      'opencode run --model llmgateway/deepseek-v4-flash ' +
        JSON.stringify(
          [
            'You are investigating an unfamiliar codebase. Tool routing, measured:',
            'Use: git why "a question in plain words"  -- searches commit history by',
            'MEANING. Reach for it when you cannot name the exact symbol to grep for.',
            'Use: git log -S SYMBOL  -- when you CAN name the symbol.',
            'Do not use the network. The answer is in this repository.',
            '',
            'Question: creating many schemas got slow and memory-hungry a while back.',
            'Find what was done about it and cite the commit. Verify with git show.',
          ].join(' '),
        ),
    ],
  },
  {
    name: 'index',
    title: 'Index management',
    repo: arg('zod', '/Users/allie/.cache/git-why-bench/0199f07e4778/external/colinhacks-zod'),
    script: ['git why status', 'git why index --if-needed'],
  },
];

mkdirSync(OUT, { recursive: true });

const cliDir = join(ROOT, 'dist', 'cli');
if (!existsSync(join(cliDir, 'main.js'))) {
  console.error('build first: npm run build');
  process.exit(1);
}

// A shim directory so the recording shows `git why`, the way people type it,
// rather than a path to dist/cli/main.js.
const shim = join(OUT, '.bin');
mkdirSync(shim, { recursive: true });
writeFileSync(
  join(shim, 'git-why'),
  `#!/bin/sh\nexec "${process.execPath}" "${join(cliDir, 'main.js')}" "$@"\n`,
  { mode: 0o755 },
);

let recorded = 0;
for (const s of SCENARIOS) {
  if (!existsSync(join(s.repo, '.git'))) {
    console.error(`[skip] ${s.name}: no repository at ${s.repo}`);
    continue;
  }
  const cast = join(OUT, `${s.name}.cast`);
  const body = s.script
    .map((line) => `printf '$ %s\\n' ${JSON.stringify(line)}; ${line}`)
    .join('; echo; ');
  const res = spawnSync(
    'asciinema',
    [
      'rec',
      '--overwrite',
      '--cols',
      '96',
      '--rows',
      '28',
      '--command',
      `sh -c ${JSON.stringify(body)}`,
      cast,
    ],
    {
      cwd: s.repo,
      stdio: 'inherit',
      env: { ...process.env, PATH: `${shim}:${process.env.PATH}`, NO_COLOR: '1' },
    },
  );
  if (res.status === 0) {
    console.log(`[ok] ${s.name} -> ${cast}`);
    recorded += 1;
  } else {
    console.error(`[fail] ${s.name}`);
  }
}

writeFileSync(
  join(OUT, 'index.json'),
  `${JSON.stringify(
    {
      recordedAt: new Date().toISOString(),
      note: 'Real recorded sessions. Timings are actual latency; output is whatever the tool printed.',
      casts: SCENARIOS.map((s) => ({ name: s.name, title: s.title, file: `${s.name}.cast` })),
    },
    null,
    2,
  )}\n`,
);
console.log(`\nrecorded ${recorded}/${SCENARIOS.length}`);
