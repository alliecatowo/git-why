#!/usr/bin/env node
/**
 * Validates the shipped plugin manifests.
 *
 * These are data files that nothing imports, so a typo in one is invisible to
 * the type checker and to every test — it surfaces when a user installs the
 * plugin and it silently does not load. That already happened once: the full
 * plugin registered `zg mcp`, a subcommand that does not exist, and would have
 * failed to start for everyone.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLUGINS = join(ROOT, 'plugins');

let failures = 0;
const fail = (msg) => {
  console.error(`verify-plugins: FAIL — ${msg}`);
  failures += 1;
};

for (const name of readdirSync(PLUGINS)) {
  const dir = join(PLUGINS, name);
  const manifestPath = join(dir, '.claude-plugin', 'plugin.json');
  if (!existsSync(manifestPath)) {
    fail(`${name} has no .claude-plugin/plugin.json`);
    continue;
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    fail(`${name}: manifest is not valid JSON — ${err.message}`);
    continue;
  }
  for (const field of ['name', 'version', 'description', 'license']) {
    if (typeof manifest[field] !== 'string' || manifest[field] === '') {
      fail(`${name}: manifest is missing "${field}"`);
    }
  }
  // The licence must match the project's. A component shipped under a licence
  // the project does not use only surfaces when someone tries to depend on it,
  // and this mismatch has already occurred once.
  if (manifest.license !== 'Apache-2.0') {
    fail(`${name}: licence is "${manifest.license}", expected Apache-2.0`);
  }

  const mcpPath = join(dir, '.mcp.json');
  if (existsSync(mcpPath)) {
    let mcp;
    try {
      mcp = JSON.parse(readFileSync(mcpPath, 'utf8'));
    } catch (err) {
      fail(`${name}: .mcp.json is not valid JSON — ${err.message}`);
      continue;
    }
    const servers = mcp.mcpServers ?? {};
    if (Object.keys(servers).length === 0) fail(`${name}: .mcp.json registers no servers`);
    for (const [server, cfg] of Object.entries(servers)) {
      if (typeof cfg.command !== 'string' || cfg.command === '') {
        fail(`${name}/${server}: no command`);
      }
      if (!Array.isArray(cfg.args)) fail(`${name}/${server}: args must be an array`);
    }
  }

  // Every skill and agent needs frontmatter with a name and a description.
  // The description is what a model matches against to decide whether the
  // skill applies, so an empty one means the skill never activates.
  for (const kind of ['skills', 'agents']) {
    const base = join(dir, kind);
    if (!existsSync(base)) continue;
    const files =
      kind === 'agents'
        ? readdirSync(base).map((f) => join(base, f))
        : readdirSync(base).map((d) => join(base, d, 'SKILL.md'));
    for (const file of files) {
      if (!existsSync(file)) {
        fail(`${name}: expected ${file}`);
        continue;
      }
      const text = readFileSync(file, 'utf8');
      const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
      if (!fm) {
        fail(`${name}: ${file} has no frontmatter`);
        continue;
      }
      if (!/^name:\s*\S/m.test(fm[1])) fail(`${name}: ${file} has no name`);
      const desc = /^description:\s*(.+)$/m.exec(fm[1]);
      if (!desc) fail(`${name}: ${file} has no description`);
      else if (desc[1].trim().length < 40) {
        fail(`${name}: ${file} description is too short to match against reliably`);
      }
    }
  }
  console.log(`verify-plugins: ${name} ok`);
}

if (failures > 0) process.exit(1);
console.log('verify-plugins: all manifests valid.');
