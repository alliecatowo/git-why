#!/usr/bin/env node
/**
 * Executable entry point: argument parsing, command dispatch, rendering,
 * and process/exit handling. See `docs/spec.md` section 5 for the command
 * contract and `src/types.ts` for `ExitCode`.
 */

import { readFileSync } from 'node:fs';
import { parseArgs, argvRequestsJson, type LifecycleCommand, type ParsedLifecycle, type ParsedSearch } from './args.js';
import { resolvePathRestrictions } from './paths.js';
import { createBackend } from './wire.js';
import type { Backend, ProgressEvent, RepositoryHandle } from './ports.js';
import { renderSearchHuman, renderStatusHuman } from '../output/human.js';
import { renderSearchErrorJson, renderSearchJson, renderStatusErrorJson, renderStatusJson } from '../output/json.js';
import { ExitCode, GitWhyError, type SearchFilters, type SearchMode, type SearchRequest } from '../types.js';

const HELP_TEXT = `Usage: git why <query> [-- <path>...] [options]
       git why --query <query> [options]
       git why index|status|rebuild|gc [options]

Search Git history for the commits that explain the code.

Options:
  -n <count>            Number of distinct commits to return (default 5, max 50)
  --text                Full-text search only
  --semantic            Vector search only (default is hybrid)
  --after=<date>        Only commits at or after this date (UTC, ISO-8601)
  --before=<date>       Only commits strictly before this date (UTC, ISO-8601)
  --author=<substring>  Case-insensitive substring of author name or email
  --json                Emit the versioned JSON envelope on stdout
  --no-refresh          Never create, mutate, or repair the index; requires one to exist
  --offline             Also forbid model downloads
  --max-bytes=<n>       Bound rendered output, including JSON framing (default 16384)
  --lock-timeout=<sec>  Seconds to wait for another process (default 30)
  --query <text>        Explicit query text, for text that looks like a command or option
  --help                Show this help
  --version             Show the version

Commands:
  index                 Create or reconcile the index
  status                Report index state without mutating anything
  rebuild               Replace derived index data [--use-default-model]
  gc                    Reconcile and compact without downloading embeddings
`;

function readVersion(): string {
  try {
    const url = new URL('../../package.json', import.meta.url);
    const raw = readFileSync(url, 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function writeStdout(text: string): void {
  process.stdout.write(text);
}

function writeStderr(text: string): void {
  process.stderr.write(text);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function toGitWhyError(err: unknown): GitWhyError {
  if (err instanceof GitWhyError) return err;
  return new GitWhyError('INTERNAL', errorMessage(err));
}

function writeErrorHuman(err: GitWhyError): void {
  writeStderr(`git why: ${err.message}\n`);
  if (err.hint) writeStderr(`  ${err.hint}\n`);
}

interface ErrorContext {
  readonly json: boolean;
  readonly command: LifecycleCommand | undefined;
  readonly query: string;
  readonly mode: SearchMode;
}

function handleError(err: unknown, ctx: ErrorContext): number {
  const gw = toGitWhyError(err);
  if (ctx.command !== undefined) {
    if (ctx.json) {
      writeStdout(renderStatusErrorJson(ctx.command, gw.code, gw.message, gw.hint) + '\n');
    } else {
      writeErrorHuman(gw);
    }
  } else if (ctx.json) {
    writeStdout(renderSearchErrorJson({ query: ctx.query, mode: ctx.mode, code: gw.code, message: gw.message, hint: gw.hint }) + '\n');
  } else {
    writeErrorHuman(gw);
  }
  return gw.exitCode;
}

// Handle broken pipes (e.g. `git why ... | head`) without a stack trace.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err && err.code === 'EPIPE') {
      process.exitCode = ExitCode.OK;
      return;
    }
    throw err;
  });
}

const controller = new AbortController();
let interruptCount = 0;
process.on('SIGINT', () => {
  interruptCount += 1;
  if (interruptCount === 1) {
    controller.abort();
    process.exitCode = ExitCode.INTERRUPTED;
    // If the in-flight operation doesn't honour the abort promptly, force it.
    setTimeout(() => process.exit(ExitCode.INTERRUPTED), 3000).unref();
  } else {
    process.exit(ExitCode.INTERRUPTED);
  }
});

function makeProgressListener(): (event: ProgressEvent) => void {
  return (event) => writeStderr(`${event.stage}: ${event.message}\n`);
}

function lifecycleContext(parsed: ParsedLifecycle): ErrorContext {
  return { json: parsed.json, command: parsed.command, query: '', mode: 'hybrid' };
}

function searchContext(parsed: ParsedSearch): ErrorContext {
  return { json: parsed.json, command: undefined, query: parsed.query, mode: parsed.mode };
}

async function runLifecycle(backend: Backend, repo: RepositoryHandle, parsed: ParsedLifecycle): Promise<number> {
  const onProgress = makeProgressListener();
  const lockTimeoutMs = parsed.lockTimeoutSeconds * 1000;
  const signal = controller.signal;
  try {
    const status = await (() => {
      switch (parsed.command) {
        case 'status':
          return backend.getStatus(repo, { lockTimeoutMs, signal });
        case 'index':
          return backend.index(repo, { offline: parsed.offline, noRefresh: false, lockTimeoutMs, signal, onProgress });
        case 'rebuild':
          return backend.rebuild(repo, {
            offline: parsed.offline,
            noRefresh: false,
            lockTimeoutMs,
            signal,
            onProgress,
            useDefaultModel: parsed.useDefaultModel,
          });
        case 'gc':
          return backend.gc(repo, { offline: parsed.offline, noRefresh: false, lockTimeoutMs, signal, onProgress });
      }
    })();

    if (parsed.json) {
      writeStdout(renderStatusJson(parsed.command, status) + '\n');
    } else {
      writeStdout(renderStatusHuman(status));
    }
    return ExitCode.OK;
  } catch (err) {
    return handleError(err, lifecycleContext(parsed));
  }
}

async function runSearch(backend: Backend, repo: RepositoryHandle, parsed: ParsedSearch, cwd: string): Promise<number> {
  const onProgress = makeProgressListener();
  try {
    const paths = resolvePathRestrictions(parsed.rawPaths, { worktreeRoot: repo.identity.worktreeRoot, cwd });
    const filters: SearchFilters = { paths, after: parsed.after, before: parsed.before, author: parsed.author };
    const request: SearchRequest = { query: parsed.query, mode: parsed.mode, limit: parsed.limit, filters };

    const response = await backend.search(repo, request, {
      offline: parsed.offline,
      noRefresh: parsed.noRefresh,
      lockTimeoutMs: parsed.lockTimeoutSeconds * 1000,
      signal: controller.signal,
      onProgress,
    });

    if (parsed.json) {
      const { text } = renderSearchJson(response, { maxBytes: parsed.maxBytes });
      writeStdout(text + '\n');
    } else {
      writeStdout(renderSearchHuman(response));
    }
    return ExitCode.OK;
  } catch (err) {
    return handleError(err, searchContext(parsed));
  }
}

async function run(): Promise<number> {
  const argv = process.argv.slice(2);

  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    return handleError(err, { json: argvRequestsJson(argv), command: undefined, query: '', mode: 'hybrid' });
  }

  if (parsed.kind === 'help') {
    writeStdout(HELP_TEXT);
    return ExitCode.OK;
  }
  if (parsed.kind === 'version') {
    writeStdout(`git-why ${readVersion()}\n`);
    return ExitCode.OK;
  }

  const ctx = parsed.kind === 'command' ? lifecycleContext(parsed) : searchContext(parsed);

  let backend: Backend;
  try {
    backend = await createBackend();
  } catch (err) {
    return handleError(err, ctx);
  }

  let repo;
  try {
    repo = await backend.openRepository(process.cwd());
  } catch (err) {
    return handleError(err, ctx);
  }

  if (parsed.kind === 'command') {
    return runLifecycle(backend, repo, parsed);
  }
  return runSearch(backend, repo, parsed, process.cwd());
}

run()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    writeStderr(`git why: internal error: ${errorMessage(err)}\n`);
    process.exitCode = ExitCode.INDEX_FAILURE;
  });
