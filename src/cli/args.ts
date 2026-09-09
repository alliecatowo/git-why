/**
 * Argument parsing. Pure and synchronous: no filesystem, no process I/O
 * beyond reading the argv array handed to it. Path restrictions are
 * captured verbatim here and resolved against the repository later (see
 * `src/cli/paths.ts`), because repository-relative normalization needs the
 * repository root, which isn't known until a repository is opened.
 *
 * Every rejection throws `GitWhyError` with `exitCode: ExitCode.INVALID_INVOCATION`.
 */

import { GitWhyError, type SearchMode } from '../types.js';

export const RESERVED_COMMANDS = ['index', 'status', 'rebuild', 'gc'] as const;
export type LifecycleCommand = (typeof RESERVED_COMMANDS)[number];

const DEFAULT_LIMIT = 5;
const MIN_LIMIT = 1;
const MAX_LIMIT = 50;

const DEFAULT_MAX_BYTES = 16 * 1024;
const MIN_MAX_BYTES = 512;
const MAX_MAX_BYTES = 256 * 1024;

const DEFAULT_LOCK_TIMEOUT_SECONDS = 30;

export interface ParsedHelp {
  readonly kind: 'help';
}

export interface ParsedVersion {
  readonly kind: 'version';
}

export interface ParsedSearch {
  readonly kind: 'search';
  readonly query: string;
  readonly mode: SearchMode;
  readonly limit: number;
  /** Verbatim path tokens after the first bare `--`. Not yet repository-relative. */
  readonly rawPaths: readonly string[];
  /** Inclusive lower bound, epoch seconds, or null. */
  readonly after: number | null;
  /** Exclusive upper bound, epoch seconds, or null. */
  readonly before: number | null;
  readonly author: string | null;
  readonly json: boolean;
  readonly noRefresh: boolean;
  readonly offline: boolean;
  readonly maxBytes: number;
  readonly lockTimeoutSeconds: number;
}

export interface ParsedLifecycle {
  readonly kind: 'command';
  readonly command: LifecycleCommand;
  readonly json: boolean;
  readonly offline: boolean;
  readonly useDefaultModel: boolean;
  readonly lockTimeoutSeconds: number;
}

export type ParsedInvocation = ParsedHelp | ParsedVersion | ParsedSearch | ParsedLifecycle;

const BOOLEAN_LONG_FLAGS = new Set([
  'text',
  'semantic',
  'json',
  'no-refresh',
  'offline',
  'use-default-model',
  'help',
  'version',
]);

const VALUE_LONG_FLAGS = new Set([
  'query',
  'after',
  'before',
  'author',
  'max-bytes',
  'lock-timeout',
]);

/** Best-effort scan used only to pick an error-rendering format when parsing itself fails. */
export function argvRequestsJson(argv: readonly string[]): boolean {
  return argv.includes('--json');
}

interface Scanned {
  readonly positionals: string[];
  readonly options: Map<string, string | true>;
  readonly rawPaths: string[];
}

function invalid(message: string, hint?: string): never {
  throw new GitWhyError('INVALID_ARGUMENTS', message, { hint });
}

function scan(head: readonly string[]): Scanned {
  const positionals: string[] = [];
  const options = new Map<string, string | true>();

  for (let i = 0; i < head.length; i += 1) {
    const token = head[i] as string;

    if (token === '-n') {
      const value = head[i + 1];
      if (value === undefined) invalid('-n requires a value.');
      options.set('n', value);
      i += 1;
      continue;
    }

    if (token === '-h') {
      options.set('help', true);
      continue;
    }

    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq !== -1) {
        const name = token.slice(2, eq);
        const value = token.slice(eq + 1);
        if (!BOOLEAN_LONG_FLAGS.has(name) && !VALUE_LONG_FLAGS.has(name)) {
          invalid(`Unknown option: --${name}`);
        }
        options.set(name, value);
        continue;
      }

      const name = token.slice(2);
      if (BOOLEAN_LONG_FLAGS.has(name)) {
        options.set(name, true);
        continue;
      }
      if (VALUE_LONG_FLAGS.has(name)) {
        const value = head[i + 1];
        if (value === undefined) invalid(`--${name} requires a value.`);
        options.set(name, value);
        i += 1;
        continue;
      }
      invalid(`Unknown option: --${name}`);
    }

    if (token.startsWith('-') && token !== '-') {
      invalid(`Unknown option: ${token}`);
    }

    positionals.push(token);
  }

  return { positionals, options, rawPaths: [] };
}

function parseLimit(raw: string | true | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  if (raw === true) throw new GitWhyError('INVALID_LIMIT', '-n requires a numeric value.');
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_LIMIT || n > MAX_LIMIT) {
    throw new GitWhyError(
      'INVALID_LIMIT',
      `-n must be an integer between ${MIN_LIMIT} and ${MAX_LIMIT}, got "${raw}".`,
    );
  }
  return n;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function parseDateBoundary(
  flag: '--after' | '--before',
  raw: string | true | undefined,
): number | null {
  if (raw === undefined) return null;
  if (raw === true || !(DATE_ONLY.test(raw) || DATE_TIME_TZ.test(raw))) {
    throw new GitWhyError(
      'INVALID_DATE',
      `${flag} must be an ISO-8601 date (YYYY-MM-DD) or a timestamp with an explicit timezone, got "${String(raw)}".`,
      { hint: 'Locale-dependent date expressions are not supported.' },
    );
  }
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new GitWhyError('INVALID_DATE', `${flag} is not a valid date: "${raw}".`);
  }
  return Math.floor(ms / 1000);
}

function parseMaxBytes(raw: string | true | undefined): number {
  if (raw === undefined) return DEFAULT_MAX_BYTES;
  if (raw === true) invalid('--max-bytes requires a numeric value.');
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_MAX_BYTES || n > MAX_MAX_BYTES) {
    invalid(
      `--max-bytes must be an integer between ${MIN_MAX_BYTES} and ${MAX_MAX_BYTES}, got "${raw}".`,
    );
  }
  return n;
}

function parseLockTimeout(raw: string | true | undefined): number {
  if (raw === undefined) return DEFAULT_LOCK_TIMEOUT_SECONDS;
  if (raw === true) invalid('--lock-timeout requires a numeric value, in seconds.');
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    invalid(`--lock-timeout must be a non-negative number of seconds, got "${raw}".`);
  }
  return n;
}

function asStringOption(options: Map<string, string | true>, name: string): string | undefined {
  const value = options.get(name);
  if (value === undefined) return undefined;
  if (value === true) invalid(`--${name} requires a value.`);
  return value;
}

/**
 * `argv` is the invocation's arguments with the program name already
 * stripped (i.e. `process.argv.slice(2)`).
 */
export function parseArgs(argv: readonly string[]): ParsedInvocation {
  const sepIndex = argv.indexOf('--');
  const head = sepIndex === -1 ? argv : argv.slice(0, sepIndex);
  const rawPaths = sepIndex === -1 ? [] : argv.slice(sepIndex + 1);

  const { positionals, options } = scan(head);

  if (options.get('help') === true) return { kind: 'help' };
  if (options.get('version') === true) return { kind: 'version' };

  const jsonFlag = options.get('json') === true;
  const offlineFlag = options.get('offline') === true;
  const lockTimeoutSeconds = parseLockTimeout(options.get('lock-timeout'));

  const isLifecycle =
    positionals.length > 0 &&
    (RESERVED_COMMANDS as readonly string[]).includes(positionals[0] as string) &&
    !options.has('query');

  if (isLifecycle) {
    const command = positionals[0] as LifecycleCommand;
    if (positionals.length > 1) {
      invalid(
        `Unexpected argument "${positionals[1]}" after reserved command "${command}".`,
        'Use --query if you meant to search for that literal text.',
      );
    }

    const useDefaultModel = options.get('use-default-model') === true;
    if (useDefaultModel && command !== 'rebuild') {
      invalid('--use-default-model is only valid with "rebuild".');
    }

    const disallowed = [
      'text',
      'semantic',
      'no-refresh',
      'author',
      'after',
      'before',
      'query',
    ].filter((name) => options.has(name));
    if (disallowed.length > 0) {
      invalid(`--${disallowed[0]} is not valid with the "${command}" command.`);
    }
    if (options.has('n') || options.has('max-bytes')) {
      invalid(`-n/--max-bytes are not valid with the "${command}" command.`);
    }

    return {
      kind: 'command',
      command,
      json: jsonFlag,
      offline: offlineFlag,
      useDefaultModel,
      lockTimeoutSeconds,
    };
  }

  const explicitQuery = asStringOption(options, 'query');
  if (explicitQuery !== undefined && positionals.length > 0) {
    invalid(
      'Cannot combine --query with a positional query.',
      'Pass the query either positionally or via --query, not both.',
    );
  }

  const query = (explicitQuery ?? positionals.join(' ')).trim();
  if (query.length === 0) {
    throw new GitWhyError('EMPTY_QUERY', 'A query is required.', {
      hint: 'git why "<question>" — or git why --query "<question>" if it looks like a command or option.',
    });
  }

  const textFlag = options.get('text') === true;
  const semanticFlag = options.get('semantic') === true;
  if (textFlag && semanticFlag) {
    throw new GitWhyError('CONTRADICTORY_MODES', '--text and --semantic are mutually exclusive.');
  }
  const mode: SearchMode = textFlag ? 'text' : semanticFlag ? 'semantic' : 'hybrid';

  const noRefresh = options.get('no-refresh') === true;

  return {
    kind: 'search',
    query,
    mode,
    limit: parseLimit(options.get('n')),
    rawPaths,
    after: parseDateBoundary('--after', options.get('after')),
    before: parseDateBoundary('--before', options.get('before')),
    author: asStringOption(options, 'author') ?? null,
    json: jsonFlag,
    noRefresh,
    offline: offlineFlag,
    maxBytes: parseMaxBytes(options.get('max-bytes')),
    lockTimeoutSeconds,
  };
}
