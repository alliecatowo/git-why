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

import { spawnSync } from 'node:child_process';
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
    // for, and a person typing the command does not demonstrate it: what
    // matters is whether a model REACHES for history unprompted.
    //
    // A neutral tool list, not an instruction.
    //
    // Two earlier attempts were unusable. The first merely mentioned the tool
    // and the agent ignored it, shelling out to `gh` and answering from the
    // GitHub API -- which also means the answer never came from the repository
    // at all. The second told the agent WHICH tool to use for what, which is
    // leading the witness: of course it complies, and the recording proves
    // nothing about whether a model reaches for history on its own.
    //
    // So: list what exists, say nothing about when to use any of it, and take
    // `gh` off PATH so the network is not an escape hatch. Whatever the agent
    // then does is the actual result, including choosing badly.
    name: 'agent',
    title: 'An agent investigating why code is the way it is',
    repo: arg('zod', '/Users/allie/.cache/git-why-bench/0199f07e4778/external/colinhacks-zod'),
    agent: true,
    isolateNetwork: true,
    script: [
      'opencode run --model llmgateway/deepseek-v4-flash ' +
        JSON.stringify(
          [
            'Creating many schemas in this project got slow and memory-hungry a while',
            'back. Find out what was done about it and cite the commit.',
            '',
            'Available: git log, git show, git blame, grep, rg, and',
            'git why "a question" (searches this repository history).',
            'No network access.',
          ].join(' '),
        ),
    ],
  },
  {
    // The case with no good alternative: a comment states a constraint, and
    // only history says whether it still holds. Neither grep nor blame can
    // date a reason.
    name: 'expired-constraint',
    title: 'Checking whether a workaround is still needed',
    repo: arg('curl', '/Users/allie/.cache/git-why-bench/0199f07e4778/external/curl-curl'),
    script: ['git why "why do we avoid sending the expect 100-continue header" -n 3'],
  },
  {
    // Deliberately shows the tool LOSING. When the symbol is nameable,
    // `git log -S` scores 0.950 against 0.350, and a demo reel that only shows
    // wins teaches people to reach for the wrong tool.
    name: 'wrong-tool',
    title: 'When NOT to use this: you already know the symbol',
    repo: arg('zod', '/Users/allie/.cache/git-why-bench/0199f07e4778/external/colinhacks-zod'),
    script: ['git log -S CompiledFn --oneline -3', 'git why "the compiled fast path helper" -n 3'],
  },
  {
    name: 'timeline',
    title: 'How something changed over time',
    repo: arg('curl', '/Users/allie/.cache/git-why-bench/0199f07e4778/external/curl-curl'),
    script: ['git why "HTTP/2 multiplexing support" --timeline -n 5'],
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

/**
 * Shadows `gh` with a stub that refuses, rather than removing its directory
 * from PATH.
 *
 * Dropping every directory containing `gh` also dropped /opt/homebrew/bin,
 * which is where `opencode` lives, so the recording could not start at all.
 * Shadowing blocks the escape hatch without taking the toolchain with it.
 */
function blockNetworkTools(shimDir) {
  for (const tool of ['gh', 'curl', 'wget']) {
    writeFileSync(
      join(shimDir, tool),
      `#!/bin/sh\necho "${tool}: disabled for this recording; the answer is in the repository" >&2\nexit 127\n`,
      { mode: 0o755 },
    );
  }
}

// A second shim directory that also shadows network tools, used by scenarios
// marked isolateNetwork.
const blockShim = join(OUT, '.bin-isolated');
mkdirSync(blockShim, { recursive: true });
writeFileSync(
  join(blockShim, 'git-why'),
  `#!/bin/sh\nexec "${process.execPath}" "${join(cliDir, 'main.js')}" "$@"\n`,
  { mode: 0o755 },
);
blockNetworkTools(blockShim);

let recorded = 0;
// Re-recording one scenario should not mean re-running the agent session,
// which takes minutes and costs tokens.
const only = arg('only', null);
const selected = only === null ? SCENARIOS : SCENARIOS.filter((x) => x.name === only);
if (selected.length === 0) {
  console.error(`no scenario named ${only}; have: ${SCENARIOS.map((x) => x.name).join(', ')}`);
  process.exit(1);
}

for (const s of selected) {
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
      env: {
        ...process.env,
        // Isolated scenarios get a shim that shadows gh/curl/wget: an agent
        // reaching the GitHub API demonstrates nothing about local history,
        // and the first recording of this scenario did exactly that.
        PATH: `${s.isolateNetwork ? blockShim : shim}:${process.env.PATH}`,
        NO_COLOR: '1',
        // Git's pager emits terminal control sequences that render as noise in
        // a cast. The recordings are short by design, so paging adds nothing.
        GIT_PAGER: 'cat',
        PAGER: 'cat',
      },
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
console.log(`\nrecorded ${recorded}/${selected.length}`);
