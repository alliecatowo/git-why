#!/usr/bin/env node
/**
 * Generates `man/git-why.1` from the CLI's own `--help` output.
 *
 * Why this exists: `git why --help` (the literal first argument) is
 * intercepted by Git itself before `git-why` ever runs — `git.c` rewrites it
 * to `git help why --exclude-guides`, which looks for a `git-why` man page
 * and, finding none, prints "No manual entry for git-why" instead of ever
 * invoking the external command (verified with `GIT_TRACE=1` against a
 * throwaway `git-<name>` script; see `scripts/verify-package.mjs`). Shipping
 * a real man page is the only way to make `git why --help` behave the same
 * as `git-why --help` and `git why -h`.
 *
 * The roff is generated, not hand-maintained, so the two surfaces cannot
 * drift: this script runs the just-built `dist/cli/main.js --help` and turns
 * its own output into a man page, rather than re-describing the options by
 * hand a second time. It runs as the last step of `npm run build`, after
 * `dist/cli/main.js` exists and is executable (see `scripts/postbuild.mjs`).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const entry = path.join(repoRoot, 'dist', 'cli', 'main.js');
const outFile = path.join(repoRoot, 'man', 'git-why.1');

if (!existsSync(entry)) {
  console.error(`gen-man: expected build output at ${entry}. Run the build first.`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const version = pkg.version ?? '0.0.0';

// Same invocation `main.ts`'s own `run()` special-cases before it ever opens
// a repository or backend, so this is safe to run from any directory with no
// model, index, or Git repository present.
const helpText = execFileSync(process.execPath, [entry, '--help'], { encoding: 'utf8' });

/**
 * Roff escaping: a leading `-` is treated as a hyphenation point unless
 * escaped, which can misrender flag names like `--no-refresh` across a
 * line-wrap; a leading `.` on an output line is a roff request, not text.
 * Backslashes must be escaped first so the substitutions below don't collide.
 */
function roffEscape(text) {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/-/g, '\\-')
    .split('\n')
    .map((line) => (line.startsWith('.') || line.startsWith("'") ? `\\&${line}` : line))
    .join('\n');
}

/**
 * Parses one blank-line-delimited block of `  <flag>  <description>` lines
 * (used for both "Options:" and "Commands:") into entries, folding
 * further-indented continuation lines (no flag column) into the previous
 * entry's description. Both `helpText` blocks already use this exact shape
 * (see `HELP_TEXT` in `src/cli/main.ts`) — this parser depends on it staying
 * that way, which is the price of not hand-maintaining a second copy.
 */
function parseEntries(lines) {
  const entries = [];
  const headPattern = /^ {2}(\S.*?) {2,}(\S.*)$/;
  // A flag whose name is too long for the description column puts the
  // description on the following line instead, e.g. `--first --last
  // --removed`. Such a line is still a head, not a continuation: heads sit at
  // exactly two spaces of indent, continuations at more. Without this case the
  // flag folds into the PREVIOUS entry's description and disappears from the
  // man page entirely -- which is how `--first`, `--last` and `--removed` went
  // undocumented.
  const bareHeadPattern = /^ {2}(\S.*\S|\S)$/;
  for (const line of lines) {
    const m = headPattern.exec(line);
    if (m) {
      entries.push({ flag: m[1], desc: m[2] });
      continue;
    }
    const bare = bareHeadPattern.exec(line);
    if (bare) {
      entries.push({ flag: bare[1], desc: '' });
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.length > 0 && entries.length > 0) {
      const last = entries[entries.length - 1];
      last.desc = last.desc.length > 0 ? `${last.desc} ${trimmed}` : trimmed;
    }
  }
  return entries;
}

function buildRoff(text, { version, date }) {
  const lines = text.replace(/\n$/, '').split('\n');

  const usageLines = [];
  let i = 0;
  // First block: one or more "Usage: ..." / continuation lines.
  while (i < lines.length && lines[i].length > 0) {
    usageLines.push(lines[i].replace(/^Usage:\s*/, ''));
    i += 1;
  }
  while (i < lines.length && lines[i].length === 0) i += 1;

  const descriptionLines = [];
  while (i < lines.length && lines[i].length > 0 && lines[i] !== 'Options:') {
    descriptionLines.push(lines[i]);
    i += 1;
  }
  while (i < lines.length && lines[i].length === 0) i += 1;

  if (lines[i] !== 'Options:') {
    throw new Error(`gen-man: expected an "Options:" block, found ${JSON.stringify(lines[i])}`);
  }
  i += 1;
  const optionLines = [];
  while (i < lines.length && lines[i].length > 0) {
    optionLines.push(lines[i]);
    i += 1;
  }
  while (i < lines.length && lines[i].length === 0) i += 1;

  if (lines[i] !== 'Commands:') {
    throw new Error(`gen-man: expected a "Commands:" block, found ${JSON.stringify(lines[i])}`);
  }
  i += 1;
  const commandLines = [];
  while (i < lines.length && lines[i].length > 0) {
    commandLines.push(lines[i]);
    i += 1;
  }
  while (i < lines.length && lines[i].length === 0) i += 1;

  // Remaining blocks are optional and may appear in any order, so they are
  // collected by heading rather than by position. Assuming a fixed order is
  // how adding a "Server:" block silently truncated the page at the first
  // heading the parser did not expect, losing every flag after it.
  const blocks = new Map();
  while (i < lines.length) {
    const heading = lines[i];
    if (!heading.endsWith(':')) break;
    i += 1;
    const collected = [];
    while (i < lines.length && lines[i].length > 0) {
      collected.push(lines[i]);
      i += 1;
    }
    blocks.set(heading, collected);
    while (i < lines.length && lines[i].length === 0) i += 1;
  }
  const commandOptionLines = blocks.get('Command options:') ?? [];
  const serverLines = blocks.get('Server:') ?? [];

  const options = parseEntries(optionLines);
  const commands = parseEntries(commandLines);
  const commandOptions = parseEntries(commandOptionLines);
  const serverCommands = parseEntries(serverLines);

  const out = [];
  out.push(`.TH GIT-WHY 1 "${date}" "git-why ${version}" "Git Manual"`);
  out.push('.SH NAME');
  out.push('git-why \\- Search Git history for the commits that explain the code');
  out.push('.SH SYNOPSIS');
  for (const line of usageLines) {
    out.push(`.B ${roffEscape(line.trim())}`);
    out.push('.br');
  }
  out.push('.SH DESCRIPTION');
  out.push(roffEscape(descriptionLines.join(' ')));
  out.push('.SH OPTIONS');
  for (const { flag, desc } of options) {
    out.push('.TP');
    out.push(`.B ${roffEscape(flag)}`);
    out.push(roffEscape(desc));
  }
  out.push('.SH COMMANDS');
  for (const { flag, desc } of commands) {
    out.push('.TP');
    out.push(`.B ${roffEscape(flag)}`);
    out.push(roffEscape(desc));
  }
  if (serverCommands.length > 0) {
    out.push('.SH SERVER');
    for (const { flag, desc } of serverCommands) {
      out.push('.TP');
      out.push(`.B ${roffEscape(flag)}`);
      out.push(roffEscape(desc));
    }
  }
  if (commandOptions.length > 0) {
    out.push('.SH COMMAND OPTIONS');
    for (const { flag, desc } of commandOptions) {
      out.push('.TP');
      out.push(`.B ${roffEscape(flag)}`);
      out.push(roffEscape(desc));
    }
  }
  out.push('.SH SEE ALSO');
  out.push('.BR git (1)');
  out.push('');
  return out.join('\n');
}

const today = new Date().toISOString().slice(0, 10);
const roff = buildRoff(helpText, { version, date: today });

mkdirSync(path.dirname(outFile), { recursive: true });
writeFileSync(outFile, roff, 'utf8');
console.log(`gen-man: wrote ${path.relative(repoRoot, outFile)} (${roff.length} bytes).`);
