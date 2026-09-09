#!/usr/bin/env node
/** Rebuilds the demo repository and runs the README's queries against it. */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDemoRepo } from '../bench/fixtures/demo/build.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'dist', 'cli', 'main.js');
const repo = buildDemoRepo();

const QUERIES = [
  'that bizarre bug where reconnecting subscribed twice',
  'why do we keep the session when the refresh token is empty?',
];

for (const query of QUERIES) {
  process.stdout.write(`$ git why ${JSON.stringify(query)}\n\n`);
  process.stdout.write(
    execFileSync(process.execPath, [cli, query, '-n', '1'], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }),
  );
  process.stdout.write('\n');
}
