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
    description:
      'Search the current Git repository history for commits explaining a natural-language question.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you want to learn from Git history.' },
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
      },
      required: ['query'],
    },
  },
  {
    name: 'git_why_status',
    description: 'Inspect the Git Why index status for a repository.',
    inputSchema: { type: 'object', properties: { cwd: { type: 'string' } } },
  },
];

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
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
        const result = await runCli(cliArgs, args.cwd ? String(args.cwd) : undefined);
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
