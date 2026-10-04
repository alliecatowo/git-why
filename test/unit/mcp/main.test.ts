import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleLine, mcpTools, resolveToolCwd, searchCliArgs } from '../../../src/mcp/main.js';

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
    '--query=why do we retry twice',
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
  assert.deepEqual(searchCliArgs({ query: 'why' }), ['--query=why', '-n', '5', '--json']);
});

test('an empty or whitespace query is rejected rather than searched for', () => {
  assert.throws(() => searchCliArgs({}), /query is required/);
  assert.throws(() => searchCliArgs({ query: '   ' }), /query is required/);
});

test('each temporal type maps to the flag the CLI actually accepts', () => {
  const flagsFor = (temporal: unknown) =>
    searchCliArgs({ query: 'q', temporal }).filter(
      (a) => a.startsWith('--') && a !== '--json' && !a.startsWith('--query='),
    );
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

test('`git-why mcp` speaks MCP over stdio', async () => {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const cli = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../src/cli/main.js',
  );
  const child = spawn(process.execPath, [cli, 'mcp'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines: string[] = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => lines.push(...chunk.split('\n').filter(Boolean)));
  child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
  child.stdin.end();
  await new Promise((resolve) => child.on('close', resolve));
  const reply = JSON.parse(lines[0] ?? '{}') as { result?: { tools?: { name: string }[] } };
  assert.deepEqual(
    reply.result?.tools?.map((t) => t.name),
    ['git_why_search', 'git_why_status'],
  );
});

test('a query that looks like a flag or a command word is searched for, not interpreted', () => {
  assert.deepEqual(searchCliArgs({ query: '--first-class foo' }).slice(0, 1), [
    '--query=--first-class foo',
  ]);
  assert.deepEqual(searchCliArgs({ query: 'help' }).slice(0, 1), ['--query=help']);
  assert.deepEqual(searchCliArgs({ query: 'status' }).slice(0, 1), ['--query=status']);
});

test('ping is answered, and malformed JSON gets a parse error instead of silence', async () => {
  const pong = await handleLine('{"jsonrpc":"2.0","id":7,"method":"ping"}');
  assert.deepEqual(pong, { jsonrpc: '2.0', id: 7, result: {} });
  const bad = await handleLine('{not json');
  assert.equal((bad?.error as { code: number }).code, -32700);
});

test('initialize negotiates a protocol version the client asked for, and falls back otherwise', async () => {
  const modern = await handleLine(
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}',
  );
  assert.equal((modern?.result as { protocolVersion: string }).protocolVersion, '2025-06-18');
  const unknown = await handleLine(
    '{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"1999-01-01"}}',
  );
  assert.equal((unknown?.result as { protocolVersion: string }).protocolVersion, '2024-11-05');
});

test('a tool that fails returns an isError result the model can read, not a JSON-RPC error', async () => {
  const reply = await handleLine(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'git_why_search', arguments: { query: 'q' } },
    }),
    async () => {
      throw new Error('no usable git repository');
    },
  );
  assert.equal(reply?.error, undefined);
  const result = reply?.result as { isError: boolean; content: { text: string }[] };
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /no usable git repository/);
});

test('notifications get no reply, and unknown methods with an id get method-not-found', async () => {
  assert.equal(await handleLine('{"jsonrpc":"2.0","method":"notifications/initialized"}'), null);
  const unknown = await handleLine('{"jsonrpc":"2.0","id":9,"method":"nope"}');
  assert.equal((unknown?.error as { code: number }).code, -32601);
});

test('tool cwd is confined to the server directory and configured roots', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-why-mcp-root-'));
  const inside = path.join(root, 'repo');
  fs.mkdirSync(inside);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'git-why-mcp-out-'));
  try {
    assert.equal(resolveToolCwd(undefined, [root]), undefined);
    assert.equal(resolveToolCwd(inside, [root]), fs.realpathSync(inside));
    assert.throws(() => resolveToolCwd(outside, [root]), /outside the directories/);
    // `..` tricks and a missing directory are refused rather than followed.
    assert.throws(() => resolveToolCwd(path.join(inside, '..', '..'), [root]), /outside/);
    assert.throws(
      () => resolveToolCwd(path.join(root, 'nope'), [root]),
      /not an existing directory/,
    );
    // An explicit root, or `*`, lifts it.
    assert.equal(resolveToolCwd(outside, [root, outside]), fs.realpathSync(outside));
    assert.equal(resolveToolCwd(outside, ['*']), fs.realpathSync(outside));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
