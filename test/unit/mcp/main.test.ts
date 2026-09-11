import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchCliArgs, mcpTools } from '../../../src/mcp/main.js';

// The MCP server IS the plugin. Anything it fails to expose is a feature no
// agent can reach, and the failure is silent — `--owners` was a headline CLI
// feature that the MCP surface simply had no parameter for, so an agent asked
// "who built this" had no way to answer it.

test('every advertised search parameter reaches the CLI', () => {
  const search = mcpTools.find((t) => t.name === 'git_why_search');
  assert.ok(search, 'git_why_search must be advertised');
  const params = Object.keys(search.inputSchema.properties ?? {});
  // `cwd` is where the CLI runs, not an argument to it.
  const passthrough = params.filter((p) => p !== 'cwd');
  const sample: Record<string, unknown> = {
    query: 'why do we retry twice',
    limit: 7,
    sort: 'oldest',
    mode: 'text',
    temporal: { type: 'first' },
    groups: ['retry backoff'],
    owners: true,
  };
  // If a parameter is added to the schema without a sample here, this fails
  // rather than silently testing less than it claims to.
  for (const p of passthrough) {
    assert.ok(p in sample, `no sample value for advertised parameter ${p}; add one`);
  }
  const args = searchCliArgs(sample);
  assert.deepEqual(args, [
    'why do we retry twice',
    '-n',
    '7',
    '--json',
    '--sort=oldest',
    '--text',
    '--first',
    '--group',
    'retry backoff',
    '--owners',
  ]);
});

test('a minimal call asks for JSON and a default limit, and nothing else', () => {
  assert.deepEqual(searchCliArgs({ query: 'why' }), ['why', '-n', '5', '--json']);
});

test('an empty or whitespace query is rejected rather than searched for', () => {
  assert.throws(() => searchCliArgs({}), /query is required/);
  assert.throws(() => searchCliArgs({ query: '   ' }), /query is required/);
});

test('each temporal type maps to the flag the CLI actually accepts', () => {
  const flagsFor = (temporal: unknown) =>
    searchCliArgs({ query: 'q', temporal }).filter((a) => a.startsWith('--') && a !== '--json');
  assert.deepEqual(flagsFor({ type: 'first' }), ['--first']);
  assert.deepEqual(flagsFor({ type: 'last' }), ['--last']);
  assert.deepEqual(flagsFor({ type: 'removed' }), ['--removed']);
  assert.deepEqual(flagsFor({ type: 'timeline' }), ['--timeline']);
  assert.deepEqual(flagsFor({ type: 'around', anchor: 'v1.2.0' }), ['--around=v1.2.0']);
  assert.deepEqual(flagsFor({ type: 'between', anchor: 'v1.0.0', anchorEnd: 'v2.0.0' }), [
    '--between=v1.0.0,v2.0.0',
  ]);
  // An anchored type with no anchor is dropped, not passed through as a flag
  // the CLI would reject.
  assert.deepEqual(flagsFor({ type: 'around' }), []);
  assert.deepEqual(flagsFor({ type: 'between', anchor: 'v1.0.0' }), []);
});

test('owners is opt-in, and only on an explicit true', () => {
  assert.ok(!searchCliArgs({ query: 'q' }).includes('--owners'));
  assert.ok(!searchCliArgs({ query: 'q', owners: false }).includes('--owners'));
  assert.ok(!searchCliArgs({ query: 'q', owners: 'yes' }).includes('--owners'));
  assert.ok(searchCliArgs({ query: 'q', owners: true }).includes('--owners'));
});

test('both tools carry a description an agent can route on', () => {
  for (const tool of mcpTools) {
    assert.ok(tool.description.length > 80, `${tool.name} needs a real description`);
  }
  const search = mcpTools.find((t) => t.name === 'git_why_search');
  assert.ok(search);
  // The measured boundary must survive edits to the description: a tool that
  // oversells itself makes an agent worse at its job.
  assert.match(search.description, /git log -S/);
  assert.match(search.description, /DO NOT USE/);
});
