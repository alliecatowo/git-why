#!/usr/bin/env node
/** Minimal MCP stdio bridge; keeps the MCP surface on the stable CLI JSON contract. */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../cli/main.js');

type Rpc = {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
};

function reply(id: Rpc['id'], result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function error(id: Rpc['id'], code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

function runCli(args: string[], cwd: string | undefined): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        const parsed = JSON.parse(stdout);
        if (code !== 0)
          reject(new Error(parsed.error?.message ?? (stderr || `git why exited ${code}`)));
        else resolve(parsed);
      } catch {
        reject(new Error(stderr || `git why exited ${code}`));
      }
    });
  });
}

const tools = [
  {
    name: 'git_why_search',
    description: [
      'Find the commits that explain WHY code is the way it is: the rationale behind a',
      'design, whether an approach was already tried and reverted, what a past incident',
      'was, or who established an area.',
      '',
      'USE THIS when you cannot name the exact symbol or string to search for. On',
      'questions where keyword search fails, it scores ~18x `git log --grep`.',
      '',
      'DO NOT USE THIS when you already know the identifier. `git log -S<symbol>` is',
      'measurably better for that (Hit@10 0.950 vs 0.350) -- if you can see the name in',
      'the code, run pickaxe search instead. For the CURRENT state of the code rather',
      'than its history, use a code search tool; this only reads history.',
      '',
      'Ask the way you would ask a colleague who was there. Vague, natural phrasing',
      'works BETTER than technical phrasing here -- restating a question in technical',
      'vocabulary measurably trades away more recall than it gains in precision.',
      '',
      'Results are ranked by relevance, not proven. It misses roughly seven hard',
      'questions in ten. Verify a result with `git show <sha>` before acting on it, and',
      'if nothing looks relevant say so rather than constructing a rationale from a weak',
      'match.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'The question, phrased naturally. "why do we retry twice before giving up", "what was that bug with duplicate webhook deliveries". Describe a symptom or a decision, not a file -- `git log -- <path>` already does files, and does them better.',
        },
        cwd: {
          type: 'string',
          description: 'Repository directory. Defaults to the server process directory.',
        },
        limit: { type: 'number', minimum: 1, maximum: 50 },
        sort: { type: 'string', enum: ['relevance', 'oldest', 'newest'] },
        mode: { type: 'string', enum: ['hybrid', 'text', 'semantic'] },
        temporal: {
          type: 'object',
          description:
            'Optional temporal retrieval constraint. Query decomposition is performed by the CLI when omitted.',
          properties: {
            type: {
              type: 'string',
              enum: [
                'first',
                'last',
                'removed',
                'changed_when',
                'before',
                'after',
                'between',
                'around',
                'timeline',
              ],
            },
            anchor: { type: 'string' },
            anchorEnd: { type: 'string' },
          },
        },
        groups: {
          type: 'array',
          items: { type: 'string' },
          description: 'Additional query groups to fuse by commit-level RRF.',
        },
        owners: {
          type: 'boolean',
          description:
            'Also return who established this area, ranked by the relevance of their commits rather than by surviving lines (git blame) or commit count (git shortlog). Use for "who built this", "who should review this", "who would know about this".',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'git_why_status',
    description: `Report whether this repository's history index exists and is current.

USE THIS when git_why_search returns an index error, or before searching a
repository for the first time. The answer is actionable: if "state" is not
"current", run \`git why index --if-needed\` in a shell -- it is idempotent and
takes about 0.2s when there is nothing to do.

An index is built once per repository and shared by all its worktrees. A first
build on a large repository takes minutes, so do it deliberately rather than
inside a loop.`,
    inputSchema: { type: 'object', properties: { cwd: { type: 'string' } } },
  },
];

/**
 * Maps MCP tool arguments onto CLI flags.
 *
 * Exported and pure so it can be tested without spawning anything. This is the
 * whole plugin surface -- a flag that silently fails to map here is a feature
 * an agent cannot reach, which is how `--owners` went missing from the MCP
 * server while being a headline feature of the CLI.
 */
export function searchCliArgs(args: Record<string, unknown>): string[] {
  const query = String(args.query ?? '').trim();
  if (!query) throw new Error('query is required');
  const cliArgs = [query, '-n', String(args.limit ?? 5), '--json'];
  if (args.sort) cliArgs.push(`--sort=${String(args.sort)}`);
  if (args.mode === 'text') cliArgs.push('--text');
  if (args.mode === 'semantic') cliArgs.push('--semantic');
  const temporal = args.temporal as Record<string, unknown> | undefined;
  if (temporal?.type) {
    const type = String(temporal.type);
    if (['first', 'last', 'removed', 'timeline'].includes(type)) cliArgs.push(`--${type}`);
    else if (type === 'between' && temporal.anchor && temporal.anchorEnd)
      cliArgs.push(`--between=${String(temporal.anchor)},${String(temporal.anchorEnd)}`);
    else if (['before', 'after', 'around'].includes(type) && temporal.anchor)
      cliArgs.push(`--${type}=${String(temporal.anchor)}`);
  }
  if (Array.isArray(args.groups))
    for (const group of args.groups) cliArgs.push('--group', String(group));
  if (args.owners === true) cliArgs.push('--owners');
  return cliArgs;
}

/** The advertised tool list, exported so tests can assert its shape. */
export const mcpTools = tools;

/**
 * Only start reading stdin when this file IS the process entry point.
 *
 * Without the guard, importing anything from this module (a test asserting the
 * tool list, say) attaches a readline interface to stdin, which keeps the
 * process alive forever and hangs the run.
 */
const isEntryPoint =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

const rl = isEntryPoint ? createInterface({ input: process.stdin, crlfDelay: Infinity }) : null;
rl?.on('line', async (line) => {
  let request: Rpc;
  try {
    request = JSON.parse(line) as Rpc;
  } catch {
    return;
  }
  if (request.method === 'initialize') {
    reply(request.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'git-why', version: '0.1.0' },
    });
  } else if (request.method === 'notifications/initialized') {
    return;
  } else if (request.method === 'tools/list') {
    reply(request.id, { tools });
  } else if (request.method === 'tools/call') {
    const name = String(request.params?.name ?? '');
    const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
    try {
      if (name === 'git_why_search') {
        const result = await runCli(searchCliArgs(args), args.cwd ? String(args.cwd) : undefined);
        reply(request.id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      } else if (name === 'git_why_status') {
        const result = await runCli(['status', '--json'], args.cwd ? String(args.cwd) : undefined);
        reply(request.id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      } else {
        error(request.id, -32602, `unknown tool: ${name}`);
      }
    } catch (cause) {
      error(request.id, -32000, cause instanceof Error ? cause.message : String(cause));
    }
  } else if (request.id !== undefined) {
    error(request.id, -32601, `method not found: ${request.method}`);
  }
});
