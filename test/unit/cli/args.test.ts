import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArgs, argvRequestsJson, type ParsedLifecycle, type ParsedSearch } from '../../../src/cli/args.js';
import { GitWhyError, type GitWhyErrorCode, ExitCode } from '../../../src/types.js';

/** Asserts `err` is a `GitWhyError` with the given code, and returns the exit code for further checks. */
function expectGitWhyError(err: unknown, code: GitWhyErrorCode): number {
  if (!(err instanceof GitWhyError)) throw new Error(`expected a GitWhyError, got ${String(err)}`);
  assert.equal(err.code, code);
  return err.exitCode;
}

function search(argv: readonly string[]): ParsedSearch {
  const parsed = parseArgs(argv);
  assert.equal(parsed.kind, 'search');
  return parsed as ParsedSearch;
}

function command(argv: readonly string[]): ParsedLifecycle {
  const parsed = parseArgs(argv);
  assert.equal(parsed.kind, 'command');
  return parsed as ParsedLifecycle;
}

test('a plain quoted query', () => {
  const p = search(['duplicate websocket events after reconnect']);
  assert.equal(p.query, 'duplicate websocket events after reconnect');
  assert.equal(p.mode, 'hybrid');
  assert.equal(p.limit, 5);
  assert.deepEqual(p.rawPaths, []);
});

test('a query followed by a directory path restriction', () => {
  const p = search(['retry behavior', '--', 'src/network/']);
  assert.equal(p.query, 'retry behavior');
  assert.deepEqual(p.rawPaths, ['src/network/']);
});

test('a query followed by a file path restriction', () => {
  const p = search(['token refresh', '--', 'src/auth/session.ts']);
  assert.equal(p.query, 'token refresh');
  assert.deepEqual(p.rawPaths, ['src/auth/session.ts']);
});

test('unquoted multi-word positional query joined with -n', () => {
  const p = search(['old', 'queue', 'implementation', '-n', '20']);
  assert.equal(p.query, 'old queue implementation');
  assert.equal(p.limit, 20);
});

test('quoted multi-word query with -n', () => {
  const p = search(['old queue implementation', '-n', '20']);
  assert.equal(p.query, 'old queue implementation');
  assert.equal(p.limit, 20);
});

test('date range with = syntax', () => {
  const p = search(['postgres pooling', '--after=2024-01-01', '--before=2025-01-01']);
  assert.equal(p.after, Date.parse('2024-01-01T00:00:00Z') / 1000);
  assert.equal(p.before, Date.parse('2025-01-01T00:00:00Z') / 1000);
});

test('author filter', () => {
  const p = search(['rate limiting', '--author=maya']);
  assert.equal(p.author, 'maya');
});

test('--text selects text-only mode', () => {
  const p = search(['ReconnectManager', '--text']);
  assert.equal(p.mode, 'text');
});

test('--semantic selects semantic-only mode', () => {
  const p = search(['failure caused by reconnecting twice', '--semantic']);
  assert.equal(p.mode, 'semantic');
});

test('--json and --no-refresh compose', () => {
  const p = search(['refresh loop', '--json', '--no-refresh']);
  assert.equal(p.json, true);
  assert.equal(p.noRefresh, true);
});

test('--query disambiguates a query that looks like a reserved command word', () => {
  const p = search(['--query', 'index']);
  assert.equal(p.query, 'index');
});

test('--query disambiguates a query that looks like an option', () => {
  const p = search(['--query', '--experimental']);
  assert.equal(p.query, '--experimental');
});

test('index/status/rebuild/gc are reserved commands', () => {
  assert.equal(command(['index']).command, 'index');
  assert.equal(command(['status']).command, 'status');
  assert.equal(command(['rebuild']).command, 'rebuild');
  assert.equal(command(['gc']).command, 'gc');
});

test('status --json requests the JSON status envelope', () => {
  const p = command(['status', '--json']);
  assert.equal(p.command, 'status');
  assert.equal(p.json, true);
});

test('rebuild --use-default-model', () => {
  const p = command(['rebuild', '--use-default-model']);
  assert.equal(p.command, 'rebuild');
  assert.equal(p.useDefaultModel, true);
});

test('--use-default-model is rejected outside of rebuild', () => {
  assert.throws(() => parseArgs(['gc', '--use-default-model']), GitWhyError);
});

test('--help short-circuits regardless of position', () => {
  assert.deepEqual(parseArgs(['--help']), { kind: 'help' });
});

test('-h is accepted as help', () => {
  assert.deepEqual(parseArgs(['-h']), { kind: 'help' });
});

test('--version short-circuits', () => {
  assert.deepEqual(parseArgs(['--version']), { kind: 'version' });
});

// --- Rejection cases -------------------------------------------------

test('an empty query is rejected with EMPTY_QUERY, exit 2', () => {
  try {
    parseArgs([]);
    assert.fail('expected parseArgs to throw');
  } catch (err) {
    assert.equal(expectGitWhyError(err, 'EMPTY_QUERY'), ExitCode.INVALID_INVOCATION);
  }
});

test('an all-whitespace query is rejected as empty', () => {
  try {
    parseArgs(['   ']);
    assert.fail('expected parseArgs to throw');
  } catch (err) {
    expectGitWhyError(err, 'EMPTY_QUERY');
  }
});

test('--text and --semantic together are contradictory modes', () => {
  try {
    parseArgs(['q', '--text', '--semantic']);
    assert.fail('expected parseArgs to throw');
  } catch (err) {
    assert.equal(expectGitWhyError(err, 'CONTRADICTORY_MODES'), ExitCode.INVALID_INVOCATION);
  }
});

test('an invalid date is rejected', () => {
  try {
    parseArgs(['q', '--after=not-a-date']);
    assert.fail('expected parseArgs to throw');
  } catch (err) {
    expectGitWhyError(err, 'INVALID_DATE');
  }
});

test('a timezone-less timestamp is rejected (locale-dependent date expressions are out of scope)', () => {
  try {
    parseArgs(['q', '--before=2024-01-01T10:00:00']);
    assert.fail('expected parseArgs to throw');
  } catch (err) {
    expectGitWhyError(err, 'INVALID_DATE');
  }
});

test('a full ISO timestamp with an explicit timezone is accepted', () => {
  const p = search(['q', '--after=2024-01-01T10:00:00+02:00']);
  assert.equal(p.after, Date.parse('2024-01-01T10:00:00+02:00') / 1000);
});

test('a Z-suffixed timestamp is accepted', () => {
  const p = search(['q', '--before=2024-06-01T00:00:00.000Z']);
  assert.equal(p.before, Date.parse('2024-06-01T00:00:00.000Z') / 1000);
});

test('-n below the minimum is rejected as an invalid limit', () => {
  try {
    parseArgs(['q', '-n', '0']);
    assert.fail('expected parseArgs to throw');
  } catch (err) {
    expectGitWhyError(err, 'INVALID_LIMIT');
  }
});

test('-n above the maximum (50) is rejected', () => {
  try {
    parseArgs(['q', '-n', '51']);
    assert.fail('expected parseArgs to throw');
  } catch (err) {
    expectGitWhyError(err, 'INVALID_LIMIT');
  }
});

test('-n at the boundaries (1 and 50) is accepted', () => {
  assert.equal(search(['q', '-n', '1']).limit, 1);
  assert.equal(search(['q', '-n', '50']).limit, 50);
});

test('a non-numeric -n is rejected', () => {
  assert.throws(() => parseArgs(['q', '-n', 'five']), GitWhyError);
});

test('an unknown long option is rejected', () => {
  try {
    parseArgs(['q', '--bogus']);
    assert.fail('expected parseArgs to throw');
  } catch (err) {
    assert.equal(expectGitWhyError(err, 'INVALID_ARGUMENTS'), ExitCode.INVALID_INVOCATION);
  }
});

test('an unknown short option is rejected', () => {
  assert.throws(() => parseArgs(['q', '-z']), GitWhyError);
});

test('combining --query with a positional query is rejected', () => {
  try {
    parseArgs(['some words', '--query', 'other']);
    assert.fail('expected parseArgs to throw');
  } catch (err) {
    expectGitWhyError(err, 'INVALID_ARGUMENTS');
  }
});

test('an unexpected argument after a reserved command word is rejected', () => {
  assert.throws(() => parseArgs(['status', 'extra']), GitWhyError);
});

test('--text is not valid on a lifecycle command', () => {
  assert.throws(() => parseArgs(['index', '--text']), GitWhyError);
});

test('--max-bytes out of range is rejected', () => {
  assert.throws(() => parseArgs(['q', '--max-bytes=100']), GitWhyError); // below the 512 floor
  assert.throws(() => parseArgs(['q', '--max-bytes=99999999']), GitWhyError); // above the 256 KiB ceiling
});

test('--max-bytes within range is accepted, default is 16384', () => {
  assert.equal(search(['q']).maxBytes, 16384);
  assert.equal(search(['q', '--max-bytes=1024']).maxBytes, 1024);
});

test('--lock-timeout defaults to 30 seconds and accepts an override', () => {
  assert.equal(search(['q']).lockTimeoutSeconds, 30);
  assert.equal(search(['q', '--lock-timeout=5']).lockTimeoutSeconds, 5);
});

test('a negative --lock-timeout is rejected', () => {
  assert.throws(() => parseArgs(['q', '--lock-timeout=-1']), GitWhyError);
});

test('argvRequestsJson is a best-effort scan usable before parsing succeeds', () => {
  assert.equal(argvRequestsJson(['q', '--json']), true);
  assert.equal(argvRequestsJson(['q']), false);
});

test('the reserved word "index" without --query is the lifecycle command, not a search', () => {
  const p = parseArgs(['index']);
  assert.equal(p.kind, 'command');
});

test('--query "index" is a literal search query, not the lifecycle command', () => {
  const p = parseArgs(['--query', 'index']);
  assert.equal(p.kind, 'search');
});
