/**
 * Argument parsing. Pure and synchronous: no filesystem, no process I/O
 * beyond reading the argv array handed to it. Path restrictions are
 * captured verbatim here and resolved against the repository later (see
 * `src/cli/paths.ts`), because repository-relative normalization needs the
 * repository root, which isn't known until a repository is opened.
 *
 * Every rejection throws `GitWhyError` with `exitCode: ExitCode.INVALID_INVOCATION`.
 */

import { GitWhyError, type ResultSort, type SearchMode } from '../types.js';
import type { TemporalFlags } from '../search/temporal/intent.js';

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
  readonly sort: ResultSort;
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
  readonly verbose: boolean;
  readonly temporalFlags: TemporalFlags;
  readonly groups: readonly string[];
  /** `--owners`: aggregate matched commits by author. */
  readonly ownersRequested: boolean;
}

export interface ParsedLifecycle {
  readonly kind: 'command';
  readonly command: LifecycleCommand;
  readonly json: boolean;
  readonly offline: boolean;
  readonly useDefaultModel: boolean;
  readonly lockTimeoutSeconds: number;
  readonly verbose: boolean;
  /** `--no-refresh`/`--refresh=off` on a lifecycle command; only `status` accepts it (read-only). */
  readonly noRefresh: boolean;
  /** `status --check-ready` only; false, and meaningless, for every other command. */
  readonly checkReady: boolean;
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
  'verbose',
  'check-ready',
  'owners',
  'first',
  'last',
  'removed',
  'timeline',
]);

const VALUE_LONG_FLAGS = new Set([
  'query',
  'after',
  'before',
  'author',
  'max-bytes',
  'lock-timeout',
  'sort',
  'refresh',
  'between',
  'around',
  'group',
]);

const REFRESH_MODES = ['off', 'wait'] as const;
type RefreshMode = (typeof REFRESH_MODES)[number];

/**
 * `--no-refresh` predates `--refresh=off|wait` and stays fully supported (it
 * is documented and muscle-memory for existing users); it is exactly
 * `--refresh=off`. `--refresh=wait` is the explicit spelling of the default
 * (refresh, waiting on the index lock as usual) for scripts that want to say
 * so without relying on the absence of a flag meaning something.
 */
function parseRefresh(options: Map<string, string | true>): boolean {
  const raw = options.get('refresh');
  const noRefreshFlag = options.get('no-refresh') === true;
  if (raw === undefined) return noRefreshFlag;
  if (raw === true || !REFRESH_MODES.includes(raw as RefreshMode)) {
    invalid(
      `--refresh must be one of ${REFRESH_MODES.join(', ')}, got ${JSON.stringify(raw)}.`,
      '--refresh=off is equivalent to --no-refresh.',
    );
  }
  const off = raw === 'off';
  if (noRefreshFlag && !off) {
    invalid('--no-refresh and --refresh=wait are contradictory.');
  }
  return off || noRefreshFlag;
}

const RESULT_SORTS: readonly ResultSort[] = ['relevance', 'newest', 'oldest'];

function parseSort(raw: unknown): ResultSort {
  if (raw === undefined) return 'relevance';
  if (typeof raw !== 'string' || !RESULT_SORTS.includes(raw as ResultSort)) {
    throw new GitWhyError(
      'INVALID_ARGUMENTS',
      `--sort must be one of ${RESULT_SORTS.join(', ')}; got ${JSON.stringify(raw)}.`,
      { hint: '--sort=oldest is useful for "when was this first introduced?" questions.' },
    );
  }
  return raw as ResultSort;
}

/** Best-effort scan used only to pick an error-rendering format when parsing itself fails. */
export function argvRequestsJson(argv: readonly string[]): boolean {
  return argv.includes('--json');
}

interface Scanned {
  readonly positionals: string[];
  readonly options: Map<string, string | true>;
  readonly rawPaths: string[];
  readonly groups: string[];
}

function invalid(message: string, hint?: string): never {
  throw new GitWhyError('INVALID_ARGUMENTS', message, { hint });
}

function scan(head: readonly string[]): Scanned {
  const positionals: string[] = [];
  const options = new Map<string, string | true>();
  const groups: string[] = [];

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
        if (name === 'group') groups.push(value);
        else options.set(name, value);
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
        if (name === 'group') groups.push(value);
        else options.set(name, value);
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

  return { positionals, options, rawPaths: [], groups };
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

function isTemporalCliAnchor(raw: string): boolean {
  return (
    /\s/.test(raw) ||
    /^[0-9a-f]{7,40}$/i.test(raw) ||
    /^v?\d+\.\d+(?:\.\d+)?(?:[-.][0-9A-Za-z.-]+)?$/.test(raw)
  );
}

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

  const { positionals, options, groups } = scan(head);

  if (options.get('help') === true) return { kind: 'help' };
  if (options.get('version') === true) return { kind: 'version' };

  // `git why help` is the bare-word spelling of `--help`. Like the reserved
  // lifecycle words below, it only claims the word when it is the entire,
  // unadorned query — `--query help` still searches for the literal text.
  if (positionals.length === 1 && positionals[0] === 'help' && !options.has('query')) {
    return { kind: 'help' };
  }

  const jsonFlag = options.get('json') === true;
  const offlineFlag = options.get('offline') === true;
  const verboseFlag = options.get('verbose') === true;
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

    const checkReady = options.get('check-ready') === true;
    if (checkReady && command !== 'status') {
      invalid('--check-ready is only valid with "status".');
    }

    // `no-refresh`/`refresh` is deliberately absent from this list: it is
    // valid on every lifecycle command syntactically, but only `status` (a
    // read-only report) can actually honour it. `index`/`rebuild`/`gc`
    // reject it themselves once `noRefresh` reaches the backend, each with
    // a command-specific hint (see src/cli/wire.ts) — a generic parse-time
    // rejection here would say less than that.
    const disallowed = ['text', 'semantic', 'author', 'after', 'before', 'query', 'sort'].filter(
      (name) => options.has(name),
    );
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
      verbose: verboseFlag,
      noRefresh: parseRefresh(options),
      checkReady,
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
  const sort = parseSort(options.get('sort'));

  const noRefresh = parseRefresh(options);
  const betweenRaw = asStringOption(options, 'between');
  let between: readonly [string, string] | undefined;
  if (betweenRaw !== undefined) {
    const parts = betweenRaw.split(',').map((part) => part.trim());
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      invalid('--between must be two anchors separated by a comma.', '--between=<start>,<end>');
    }
    between = [parts[0]!, parts[1]!];
  }
  const temporalFlags: TemporalFlags = {
    first: options.get('first') === true,
    last: options.get('last') === true,
    removed: options.get('removed') === true,
    timeline: options.get('timeline') === true,
    before: (() => {
      const raw = asStringOption(options, 'before');
      return raw !== undefined && isTemporalCliAnchor(raw) ? raw : undefined;
    })(),
    after: (() => {
      const raw = asStringOption(options, 'after');
      return raw !== undefined && isTemporalCliAnchor(raw) ? raw : undefined;
    })(),
    between,
    around: asStringOption(options, 'around'),
  };

  return {
    kind: 'search',
    query,
    mode,
    sort,
    limit: parseLimit(options.get('n')),
    rawPaths,
    after: (() => {
      const raw = options.get('after');
      return typeof raw === 'string' && isTemporalCliAnchor(raw)
        ? null
        : parseDateBoundary('--after', raw);
    })(),
    before: (() => {
      const raw = options.get('before');
      return typeof raw === 'string' && isTemporalCliAnchor(raw)
        ? null
        : parseDateBoundary('--before', raw);
    })(),
    author: asStringOption(options, 'author') ?? null,
    json: jsonFlag,
    verbose: verboseFlag,
    noRefresh,
    offline: offlineFlag,
    maxBytes: parseMaxBytes(options.get('max-bytes')),
    lockTimeoutSeconds,
    temporalFlags,
    groups,
    ownersRequested: options.get('owners') === true,
  };
}
