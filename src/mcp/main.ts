#!/usr/bin/env node
/** Minimal MCP stdio bridge; keeps the MCP surface on the stable CLI JSON contract. */
import { spawn } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
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

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/** Kill a CLI run that exceeds this; a first search must not silently become a full index build. */
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

function toolTimeoutMs(): number {
  const raw = Number(process.env.GIT_WHY_MCP_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TOOL_TIMEOUT_MS;
}

/**
 * Directories a tool call may operate in. Defaults to the server's own working
 * directory (what the MCP host launched it for); `GIT_WHY_MCP_ROOTS` adds more
 * (path-delimiter separated) and `*` lifts the restriction. Without this, any
 * caller of the tool could make git-why create and write an index inside any
 * repository on the machine.
 */
export function allowedRoots(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string[] {
  const extra = (env.GIT_WHY_MCP_ROOTS ?? '').split(path.delimiter).filter((p) => p.length > 0);
  return [cwd, ...extra];
}

/** Resolves a tool's `cwd` argument, or throws if it is outside the allowed roots. */
export function resolveToolCwd(
  requested: unknown,
  roots: readonly string[] = allowedRoots(),
): string | undefined {
  if (requested === undefined || requested === null || requested === '') return undefined;
  const wanted = String(requested);
  let real: string;
  try {
    real = realpathSync(path.resolve(wanted));
    if (!statSync(real).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error(`cwd is not an existing directory: ${wanted}`);
  }
  if (roots.includes('*')) return real;
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = realpathSync(path.resolve(root));
    } catch {
      continue;
    }
    const rel = path.relative(realRoot, real);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return real;
  }
  throw new Error(
    `cwd ${wanted} is outside the directories this server may use; set GIT_WHY_MCP_ROOTS to allow it`,
  );
}

function runCli(
  args: string[],
  cwd: string | undefined,
  timeoutMs = toolTimeoutMs(),
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }, timeoutMs);
    timer.unref();
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new Error(
            `git why did not finish within ${Math.round(timeoutMs / 1000)}s (a first search on a large repository builds its index); run \`git why index\` in a shell, then retry`,
          ),
        );
        return;
      }
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

function serverVersion(): string {
  try {
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
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
  // `--query=<q>` rather than a positional: a positional that looks like a flag
  // (`--first-class foo`) is an unknown option, and one that equals a command word
  // (`help`, `status`, `index`) is parsed as that command instead of searched for.
  const cliArgs = [`--query=${query}`, '-n', String(args.limit ?? 5), '--json'];
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

type Reply = Record<string, unknown>;

const ok = (id: Rpc['id'], result: unknown): Reply => ({ jsonrpc: '2.0', id, result });
const fail = (id: Rpc['id'] | null, code: number, message: string): Reply => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message },
});

/**
 * Handles one line of input and returns the reply to write, or null when none is
 * owed (notifications). Pure of stdio so tests can drive it; `run` is injectable.
 */
export async function handleLine(
  line: string,
  run: (args: string[], cwd: string | undefined) => Promise<unknown> = runCli,
): Promise<Reply | null> {
  let request: Rpc;
  try {
    request = JSON.parse(line) as Rpc;
  } catch {
    return fail(null, -32700, 'parse error: invalid JSON');
  }
  if (typeof request !== 'object' || request === null || typeof request.method !== 'string') {
    return fail((request as { id?: Rpc['id'] } | null)?.id ?? null, -32600, 'invalid request');
  }
  const isNotification = request.id === undefined;
  switch (request.method) {
    case 'initialize': {
      const asked = String(request.params?.protocolVersion ?? '');
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(asked)
        ? asked
        : SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1];
      return ok(request.id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'git-why', version: serverVersion() },
      });
    }
    case 'ping':
      return ok(request.id, {});
    case 'tools/list':
      return ok(request.id, { tools });
    case 'tools/call': {
      const name = String(request.params?.name ?? '');
      const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
      if (name !== 'git_why_search' && name !== 'git_why_status') {
        return fail(request.id, -32602, `unknown tool: ${name}`);
      }
      try {
        const cwd = resolveToolCwd(args.cwd);
        const result =
          name === 'git_why_search'
            ? await run(searchCliArgs(args), cwd)
            : await run(['status', '--json'], cwd);
        return ok(request.id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        });
      } catch (cause) {
        // A tool that ran and failed is a result the model can read and act on
        // (isError), not a protocol fault.
        return ok(request.id, {
          isError: true,
          content: [{ type: 'text', text: cause instanceof Error ? cause.message : String(cause) }],
        });
      }
    }
    default:
      if (isNotification || request.method.startsWith('notifications/')) return null;
      return fail(request.id, -32601, `method not found: ${request.method}`);
  }
}

/** Serve MCP over stdio until stdin closes. Also reachable as `git-why mcp`. */
export function startMcpServer(): void {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (line.trim() === '') return;
    void handleLine(line).then((reply) => {
      if (reply !== null) process.stdout.write(`${JSON.stringify(reply)}\n`);
    });
  });
}

if (isEntryPoint) startMcpServer();
