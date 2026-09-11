#!/usr/bin/env node
/**
 * Regenerates the Options and Command options tables in
 * `site/guide/cli-reference.md` from the CLI's own `--help`.
 *
 * The hand-maintained version drifted badly: it documented fourteen flags
 * while the tool had twenty-six, and every temporal flag -- `--first`,
 * `--last`, `--removed`, `--timeline`, `--around`, `--between` -- along with
 * `--owners` and `--group` was missing entirely. A reference that silently
 * omits half the surface is worse than none, because a reader concludes the
 * feature does not exist.
 *
 * Only the generated blocks are replaced; the prose around them is written by
 * hand and left alone.
 *
 *   node site/scripts/gen-cli-reference.mjs [--check]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const entry = path.join(repoRoot, 'dist', 'cli', 'main.js');
const page = path.join(repoRoot, 'site', 'guide', 'cli-reference.md');

if (!existsSync(entry)) {
  console.error(`gen-cli-reference: expected ${entry}. Run npm run build first.`);
  process.exit(1);
}

const help = execFileSync(process.execPath, [entry, '--help'], { encoding: 'utf8' });

/**
 * Same shape the man-page generator parses, and same reason for the bare-head
 * case: a flag whose description wraps to the next line is still a head, and
 * treating it as a continuation makes it vanish into its neighbour.
 */
function parseBlock(heading) {
  const lines = help.split('\n');
  const start = lines.indexOf(heading);
  if (start < 0) return [];
  const entries = [];
  for (let i = start + 1; i < lines.length && lines[i]?.length !== 0; i += 1) {
    const line = lines[i] ?? '';
    const head = /^ {2}(\S.*?) {2,}(\S.*)$/.exec(line);
    if (head) {
      entries.push({ flag: head[1], desc: head[2] });
      continue;
    }
    const bare = /^ {2}(\S.*\S|\S)$/.exec(line);
    if (bare) {
      entries.push({ flag: bare[1], desc: '' });
      continue;
    }
    const trimmed = line.trim();
    const last = entries[entries.length - 1];
    if (trimmed.length > 0 && last) {
      last.desc = last.desc.length > 0 ? `${last.desc} ${trimmed}` : trimmed;
    }
  }
  return entries;
}

// A pipe inside a description would end the table cell early.
const cell = (text) => text.replace(/\|/g, '\\|');

function table(entries) {
  const rows = entries.map((e) => `| \`${cell(e.flag)}\` | ${cell(e.desc)} |`);
  return ['| Flag | Meaning |', '| --- | --- |', ...rows].join('\n');
}

function replaceBlock(source, name, body) {
  const open = `<!-- generated:${name} -->`;
  const close = `<!-- /generated:${name} -->`;
  const start = source.indexOf(open);
  const end = source.indexOf(close);
  if (start < 0 || end < 0) {
    throw new Error(`gen-cli-reference: missing ${open} ... ${close} markers in the page`);
  }
  return `${source.slice(0, start + open.length)}\n\n${body}\n\n${source.slice(end)}`;
}

const current = readFileSync(page, 'utf8');
let next = replaceBlock(current, 'options', table(parseBlock('Options:')));
next = replaceBlock(next, 'command-options', table(parseBlock('Command options:')));
// Prettier realigns markdown table pipes, so an unformatted table would fail
// `format:check` in CI and, worse, make `--check` here report drift on a page
// nobody had touched.
next = await format(next, { parser: 'markdown', ...(await resolveConfig(page)) });

if (process.argv.includes('--check')) {
  if (next !== current) {
    console.error(
      'gen-cli-reference: site/guide/cli-reference.md is stale. Run node site/scripts/gen-cli-reference.mjs',
    );
    process.exit(1);
  }
  console.log('gen-cli-reference: up to date.');
} else {
  writeFileSync(page, next);
  console.log(`gen-cli-reference: wrote ${path.relative(repoRoot, page)}`);
}
