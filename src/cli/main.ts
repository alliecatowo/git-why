#!/usr/bin/env node
/**
 * Executable entry point: argument parsing, command dispatch, rendering,
 * and process/exit handling. See `docs/spec.md` section 5 for the command
 * contract and `src/types.ts` for `ExitCode`.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseArgs,
  argvRequestsJson,
  type LifecycleCommand,
  type ParsedLifecycle,
  type ParsedSearch,
} from './args.js';
import { resolvePathRestrictions } from './paths.js';
import { createBackend } from './wire.js';
import type { Backend, ProgressEvent, RepositoryHandle } from './ports.js';
import { renderSearchHuman, renderStatusHuman } from '../output/human.js';
import {
  renderSearchErrorJson,
  renderSearchJson,
  renderStatusErrorJson,
  renderStatusJson,
} from '../output/json.js';
import {
  ExitCode,
  GitWhyError,
  type IndexStatus,
  type SearchFilters,
  type ResultSort,
  type SearchMode,
  type SearchRequest,
} from '../types.js';
import { constraintFromFlags, decomposeQuery } from '../search/temporal/intent.js';

const HELP_TEXT = `Usage: git why <query> [-- <path>...] [options]
       git why --query <query> [options]
       git why index|status|rebuild|gc [options]
       git why help

Search Git history for the commits that explain the code.

Options:
  -n <count>            Number of distinct commits to return (default 5, max 50)
  --text                Full-text search only
  --semantic            Vector search only (default is hybrid)
  --sort=<order>        relevance (default), oldest, or newest. Reorders the
                        selected commits; never changes which are returned
  --first --last --removed
                        Resolve/order an introduction, last change, or removal
  --timeline            Return the history-oriented retrieval view
  --before=<anchor>     Temporal anchor when non-ISO (tags, SHA, or a query);
                        ISO dates remain history filters
  --after=<anchor>      Temporal anchor when non-ISO (tags, SHA, or a query)
  --between=<a>,<b>     Prefer commits between two temporal anchors
  --around=<anchor>     Prefer commits near a date, tag, or SHA
  --group <query>       Additional retrieval group; fuse groups at commit level
  --after=<date>        Only commits at or after this date (UTC, ISO-8601)
  --before=<date>       Only commits strictly before this date (UTC, ISO-8601)
  --author=<substring>  Case-insensitive substring of author name or email
  --json                Emit the versioned JSON envelope on stdout
  --refresh=<mode>      off: never create, mutate, or repair the index; requires
                        one to exist. wait: refresh normally (the default);
                        spelled out for scripts that want to say so explicitly
  --no-refresh          Alias for --refresh=off
  --offline             Also forbid model downloads
  --max-bytes=<n>       Bound rendered output, including JSON framing (default 16384)
  --lock-timeout=<sec>  Seconds to wait for another process (default 30)
  --verbose             Also report model loading and download progress on stderr
  --query <text>        Explicit query text, for text that looks like a command or option
  --help                Show this help
  --version             Show the version

Commands:
  index                 Create or reconcile the index
  status                Report index state without mutating anything
  rebuild               Replace derived index data
  gc                    Reconcile and compact without downloading embeddings
  help                  Show this help

Command options:
  --if-needed           With index: exit 0 immediately if the index is already
                        current, so it is cheap to run unconditionally
  --check-ready         With status: exit non-zero unless the index exists, is
                        current for the repository's refs, and covers every
                        reachable commit. For scripts that gate on readiness
  --use-default-model   With rebuild: re-embed with the default model rather
                        than the one recorded in the existing index
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
  readonly sort?: ResultSort;
}

function handleError(err: unknown, ctx: ErrorContext): number {
  // Once SIGINT has fired, an in-flight operation rejecting because it
  // honoured the abort signal (however it phrases that rejection) is an
  // interruption, not whatever error code the abort happened to produce.
  // Without this, main.ts's own AbortController plumbing would turn a
  // clean Ctrl-C into a misleading exit 4.
  if (controller.signal.aborted) {
    const interrupted = new GitWhyError('INTERRUPTED', 'Interrupted.');
    if (ctx.command !== undefined && ctx.json) {
      writeStdout(
        renderStatusErrorJson(
          ctx.command,
          interrupted.code,
          interrupted.message,
          interrupted.hint,
        ) + '\n',
      );
    } else if (ctx.command === undefined && ctx.json) {
      writeStdout(
        renderSearchErrorJson({
          query: ctx.query,
          mode: ctx.mode,
          sort: ctx.sort,
          code: interrupted.code,
          message: interrupted.message,
          hint: interrupted.hint,
        }) + '\n',
      );
    } else {
      writeErrorHuman(interrupted);
    }
    return ExitCode.INTERRUPTED;
  }
  const gw = toGitWhyError(err);
  if (ctx.command !== undefined) {
    if (ctx.json) {
      writeStdout(renderStatusErrorJson(ctx.command, gw.code, gw.message, gw.hint) + '\n');
    } else {
      writeErrorHuman(gw);
    }
  } else if (ctx.json) {
    writeStdout(
      renderSearchErrorJson({
        query: ctx.query,
        mode: ctx.mode,
        sort: ctx.sort,
        code: gw.code,
        message: gw.message,
        hint: gw.hint,
      }) + '\n',
    );
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

/**
 * The 'model' stage (model load + one line per ~25% download step, see
 * `src/cli/wire.ts`'s `loadEmbedder`) is by far the noisiest stage and the
 * one benchmark/agent harnesses most often mis-parse as an error because it
 * shows up on stderr unconditionally. Every other stage (reconcile,
 * extraction, embedding, compaction, gc, recovery) is what a user is
 * actually waiting on and keeps reporting unconditionally; 'model' is opt-in
 * via --verbose. Errors and warnings never go through this path at all —
 * they're written directly by `writeErrorHuman`/`handleError` — so this
 * gating cannot hide a real failure.
 */
function makeProgressListener(verbose: boolean): (event: ProgressEvent) => void {
  return (event) => {
    if (event.stage === 'model' && !verbose) return;
    writeStderr(`${event.stage}: ${event.message}\n`);
  };
}

/**
 * `status --check-ready`'s readiness contract (docs/operations.md): an index
 * must exist, be current for the repository's current refs snapshot, and
 * have complete coverage under the current policy. Policy-excluded content
 * (generated, binary, lockfile, and bounded oversize slices) is deliberately
 * outside the searchable corpus, so it is not an incomplete preparation;
 * unavailable or failed eligible files are. This is a pure read of
 * fields `IndexStatus` already carries — it does not re-derive anything
 * `computeIndexStatus` (src/index/status.ts) didn't already decide.
 */
/**
 * Readiness means "this index is built and current for the current refs", not
 * "every file in history was ingested".
 *
 * Requiring zero omissions made `--check-ready` unsatisfiable on real
 * repositories: the extraction policy deliberately skips lockfiles, binaries,
 * generated and oversized files, so a healthy zod index reports 4,611 excluded
 * and 550 failed and would never be "ready". That blocked 10 of 36 trials in
 * an agent pilot as `infrastructure_blocked` -- the treatment silently never
 * being applied, which is precisely the failure this flag exists to prevent.
 *
 * `failedFiles` counts blobs the policy expected to read and could not, so it
 * is surfaced as a warning by `status`, not as unreadiness. What actually
 * makes an index unusable is being stale, or not covering every reachable
 * commit, and both are checked here.
 */
function isIndexReady(status: IndexStatus): boolean {
  if (status.state !== 'current' || status.refsChanged) return false;
  // Null means the count could not be established, which is not evidence of
  // readiness. Requiring both to be known and equal keeps a partially built
  // index from passing.
  const { indexedCommits, reachableCommits } = status;
  if (indexedCommits === null || reachableCommits === null) return false;
  return indexedCommits === reachableCommits;
}

function lifecycleContext(parsed: ParsedLifecycle): ErrorContext {
  return { json: parsed.json, command: parsed.command, query: '', mode: 'hybrid' };
}

function searchContext(parsed: ParsedSearch): ErrorContext {
  return {
    json: parsed.json,
    command: undefined,
    query: parsed.query,
    mode: parsed.mode,
    sort: parsed.sort,
  };
}

/**
 * Reads a shipped completion script. They are data files rather than string
 * literals so the same text is what gets installed to a completion directory,
 * with no chance of the two drifting apart.
 */
function readCompletionScript(shell: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/cli/ -> package root -> completions/
  return readFileSync(path.join(here, '..', '..', 'completions', `git-why.${shell}`), 'utf8');
}

async function runLifecycle(
  backend: Backend,
  repo: RepositoryHandle,
  parsed: ParsedLifecycle,
): Promise<number> {
  const onProgress = makeProgressListener(parsed.verbose);
  const lockTimeoutMs = parsed.lockTimeoutSeconds * 1000;
  const signal = controller.signal;
  try {
    // `index --if-needed` is idempotent: when the index is already current it
    // reports and exits without rebuilding. Callers would otherwise have to
    // script `status --check-ready || index`, and getting that wrong means
    // either rebuilding a 30,000-commit index needlessly or querying a stale
    // one. Checked BEFORE the work, obviously, or it would not save anything.
    if (parsed.command === 'index' && parsed.ifNeeded) {
      const current = await backend.getStatus(repo, { lockTimeoutMs, signal });
      if (isIndexReady(current)) {
        if (parsed.json) {
          writeStdout(renderStatusJson('index', current) + '\n');
        } else {
          writeStdout(renderStatusHuman(current));
        }
        return ExitCode.OK;
      }
    }

    const status = await (() => {
      switch (parsed.command) {
        case 'status':
          // Status is read-only regardless of `noRefresh`; StatusOptions has
          // no such field to pass. Parsing still accepts --no-refresh/
          // --refresh=off here (see args.ts) so it composes for scripts.
          return backend.getStatus(repo, { lockTimeoutMs, signal });
        case 'index':
          return backend.index(repo, {
            offline: parsed.offline,
            noRefresh: parsed.noRefresh,
            lockTimeoutMs,
            signal,
            onProgress,
          });
        case 'rebuild':
          return backend.rebuild(repo, {
            offline: parsed.offline,
            noRefresh: parsed.noRefresh,
            lockTimeoutMs,
            signal,
            onProgress,
            useDefaultModel: parsed.useDefaultModel,
          });
        case 'gc':
          return backend.gc(repo, {
            offline: parsed.offline,
            noRefresh: parsed.noRefresh,
            lockTimeoutMs,
            signal,
            onProgress,
          });
      }
    })();

    if (parsed.json) {
      writeStdout(renderStatusJson(parsed.command, status) + '\n');
    } else {
      writeStdout(renderStatusHuman(status));
    }
    if (parsed.command === 'status' && parsed.checkReady) {
      return isIndexReady(status) ? ExitCode.OK : ExitCode.NO_REPOSITORY;
    }
    return ExitCode.OK;
  } catch (err) {
    return handleError(err, lifecycleContext(parsed));
  }
}

async function runSearch(
  backend: Backend,
  repo: RepositoryHandle,
  parsed: ParsedSearch,
  cwd: string,
): Promise<number> {
  const onProgress = makeProgressListener(parsed.verbose);
  try {
    const paths = resolvePathRestrictions(parsed.rawPaths, {
      worktreeRoot: repo.identity.worktreeRoot,
      cwd,
    });
    const filters: SearchFilters = {
      paths,
      after: parsed.after,
      before: parsed.before,
      author: parsed.author,
    };
    const decomposition = decomposeQuery(parsed.query);
    const temporal = constraintFromFlags(parsed.temporalFlags) ?? decomposition.constraint;
    const request: SearchRequest = {
      query: parsed.query,
      mode: parsed.mode,
      sort: parsed.sort,
      limit: parsed.limit,
      filters,
      temporal,
      groups: parsed.groups,
      owners: parsed.ownersRequested,
    };

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
    return handleError(err, {
      json: argvRequestsJson(argv),
      command: undefined,
      query: '',
      mode: 'hybrid',
    });
  }

  // `completion <shell>` is handled before anything touches a repository: it
  // emits a static script and must work outside a Git worktree, with no index
  // and no model, because that is when people set up their shell.
  if (argv[0] === 'completion') {
    const shell = argv[1];
    const known = ['bash', 'zsh', 'fish'] as const;
    if (shell === undefined || !(known as readonly string[]).includes(shell)) {
      writeStderr(`usage: git why completion <${known.join('|')}>\n`);
      return ExitCode.INVALID_INVOCATION;
    }
    try {
      writeStdout(readCompletionScript(shell));
      return ExitCode.OK;
    } catch {
      writeStderr(`git why: completion script for ${shell} is not installed\n`);
      return ExitCode.INDEX_FAILURE;
    }
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
