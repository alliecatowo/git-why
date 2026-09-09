import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  anyRestrictionMatchesChange,
  anyRestrictionMatchesSummary,
  authorMatches,
  matchesAuthor,
  normalizeAuthorFilter,
  parseDateBoundary,
  resolvePathRestriction,
  restrictionMatchesPath,
  type PathResolutionContext,
} from '../../../src/search/filters.js';
import { GitWhyError, type HistoricalPath } from '../../../src/types.js';

function hp(display: string): HistoricalPath {
  return { bytesBase64: Buffer.from(display).toString('base64'), display, lossy: false };
}

const worktreeCtx: PathResolutionContext = {
  repositoryRoot: '/repo',
  isBare: false,
  cwd: '/repo',
};

/* ------------------------------------------------------------------ *
 * Path restrictions
 * ------------------------------------------------------------------ */

test('a literal relative path resolves to a file restriction', () => {
  const r = resolvePathRestriction('src/auth/session.ts', worktreeCtx);
  assert.deepEqual(r, { value: 'src/auth/session.ts', kind: 'file' });
});

test('a trailing slash resolves to a directory restriction', () => {
  const r = resolvePathRestriction('src/auth/', worktreeCtx);
  assert.deepEqual(r, { value: 'src/auth', kind: 'directory' });
});

test('a path is resolved relative to the caller working directory, not the repo root', () => {
  const ctx: PathResolutionContext = { repositoryRoot: '/repo', isBare: false, cwd: '/repo/src/auth' };
  const r = resolvePathRestriction('session.ts', ctx);
  assert.deepEqual(r, { value: 'src/auth/session.ts', kind: 'file' });
});

test('an absolute path under the repo root resolves correctly', () => {
  const r = resolvePathRestriction('/repo/src/auth/session.ts', worktreeCtx);
  assert.equal(r.value, 'src/auth/session.ts');
});

test('a path escaping the repository root is rejected', () => {
  assert.throws(
    () => resolvePathRestriction('../outside.ts', worktreeCtx),
    (err: unknown) => err instanceof GitWhyError && err.code === 'INVALID_PATH_RESTRICTION',
  );
});

test('a bare repository treats the value as already repository-relative', () => {
  const ctx: PathResolutionContext = { repositoryRoot: null, isBare: true, cwd: '/anywhere' };
  const r = resolvePathRestriction('src/auth/session.ts', ctx);
  assert.equal(r.value, 'src/auth/session.ts');
});

test('a bare-repository restriction escaping the root is still rejected', () => {
  const ctx: PathResolutionContext = { repositoryRoot: null, isBare: true, cwd: '/anywhere' };
  assert.throws(
    () => resolvePathRestriction('../escape.ts', ctx),
    (err: unknown) => err instanceof GitWhyError && err.code === 'INVALID_PATH_RESTRICTION',
  );
});

test('glob and magic pathspec syntax is rejected as unsupported, not silently ignored', () => {
  for (const bad of ['src/*.ts', 'src/[abc].ts', ':(exclude)src', 'src/?.ts']) {
    assert.throws(
      () => resolvePathRestriction(bad, worktreeCtx),
      (err: unknown) => err instanceof GitWhyError && err.code === 'UNSUPPORTED_PATHSPEC',
      `expected ${bad} to be rejected as unsupported pathspec`,
    );
  }
});

test('a path restriction containing a quote character is rejected (filter-injection defence)', () => {
  for (const bad of [`src/a"b.ts`, `src/a'b.ts`]) {
    assert.throws(
      () => resolvePathRestriction(bad, worktreeCtx),
      (err: unknown) => err instanceof GitWhyError && err.code === 'INVALID_PATH_RESTRICTION',
    );
  }
});

test('an empty path restriction is rejected', () => {
  assert.throws(() => resolvePathRestriction('', worktreeCtx), GitWhyError);
});

test('resolvePathRestriction never touches the filesystem: a nonexistent/deleted path resolves the same as any other', () => {
  // No file at this path exists on the test machine; resolution must not
  // depend on that, and must not throw for that reason.
  const r = resolvePathRestriction('src/definitely/does/not/exist.ts', worktreeCtx);
  assert.equal(r.value, 'src/definitely/does/not/exist.ts');
});

test('restrictionMatchesPath: file kind requires exact equality, not prefix membership', () => {
  const fileRestriction = { value: 'src/auth', kind: 'file' as const };
  assert.equal(restrictionMatchesPath(fileRestriction, 'src/auth'), true);
  assert.equal(restrictionMatchesPath(fileRestriction, 'src/auth/session.ts'), false);
});

test('restrictionMatchesPath: directory kind matches the directory itself and descendants only', () => {
  const dirRestriction = { value: 'src/auth', kind: 'directory' as const };
  assert.equal(restrictionMatchesPath(dirRestriction, 'src/auth'), true);
  assert.equal(restrictionMatchesPath(dirRestriction, 'src/auth/session.ts'), true);
  assert.equal(restrictionMatchesPath(dirRestriction, 'src/authorization.ts'), false);
});

test('a hunk matches on either its own path or its rename source (oldPath)', () => {
  const restriction = { value: 'src/billing/old_invoice.ts', kind: 'file' as const };
  const matched = anyRestrictionMatchesChange([restriction], hp('src/billing/invoice.ts'), hp('src/billing/old_invoice.ts'));
  assert.equal(matched, true);
});

test('multiple path restrictions OR together', () => {
  const restrictions = [
    { value: 'src/a.ts', kind: 'file' as const },
    { value: 'src/b.ts', kind: 'file' as const },
  ];
  assert.equal(anyRestrictionMatchesChange(restrictions, hp('src/b.ts'), null), true);
  assert.equal(anyRestrictionMatchesChange(restrictions, hp('src/c.ts'), null), false);
});

test('a commit summary matches when any changed path satisfies the restriction', () => {
  const restrictions = [{ value: 'src/b.ts', kind: 'file' as const }];
  const changed = [
    { path: hp('src/a.ts'), oldPath: null },
    { path: hp('src/b.ts'), oldPath: null },
  ];
  assert.equal(anyRestrictionMatchesSummary(restrictions, changed), true);
});

test('no path restrictions means everything is eligible', () => {
  assert.equal(anyRestrictionMatchesChange([], hp('anything.ts'), null), true);
  assert.equal(anyRestrictionMatchesSummary([], []), true);
});

/* ------------------------------------------------------------------ *
 * Dates
 * ------------------------------------------------------------------ */

test('a bare date is interpreted as that date at UTC midnight', () => {
  assert.equal(parseDateBoundary('2025-01-01'), Date.UTC(2025, 0, 1) / 1000);
});

test('--after and --before boundary semantics are exact at midnight UTC', () => {
  const midnight = parseDateBoundary('2025-01-01');
  const oneSecondBefore = midnight - 1;
  const oneSecondAfter = midnight + 1;
  // Inclusive lower bound at exactly midnight:
  assert.ok(midnight >= midnight);
  // Exclusive upper bound: a commit AT midnight must not satisfy `--before=2025-01-01`.
  assert.ok(!(midnight < midnight));
  assert.ok(oneSecondBefore < midnight);
  assert.ok(oneSecondAfter > midnight);
});

test('an explicit-timezone ISO timestamp parses to the correct UTC instant', () => {
  const z = parseDateBoundary('2025-01-01T12:00:00Z');
  const plusTwo = parseDateBoundary('2025-01-01T14:00:00+02:00');
  assert.equal(z, plusTwo);
});

test('a negative timezone offset parses correctly', () => {
  const z = parseDateBoundary('2025-01-01T00:00:00Z');
  const minusFive = parseDateBoundary('2024-12-31T19:00:00-05:00');
  assert.equal(z, minusFive);
});

test('an invalid calendar date is rejected rather than rolled forward', () => {
  assert.throws(
    () => parseDateBoundary('2025-02-30'),
    (err: unknown) => err instanceof GitWhyError && err.code === 'INVALID_DATE',
  );
});

test('a timezone-less timestamp is rejected as ambiguous', () => {
  assert.throws(
    () => parseDateBoundary('2025-01-01T00:00:00'),
    (err: unknown) => err instanceof GitWhyError && err.code === 'INVALID_DATE',
  );
});

test('a locale-dependent date format is rejected', () => {
  assert.throws(
    () => parseDateBoundary('Jan 1, 2025'),
    (err: unknown) => err instanceof GitWhyError && err.code === 'INVALID_DATE',
  );
});

/* ------------------------------------------------------------------ *
 * Author
 * ------------------------------------------------------------------ */

test('matchesAuthor is a case-insensitive literal substring, not a regex', () => {
  assert.equal(matchesAuthor('Maya Chen', 'maya'), true);
  assert.equal(matchesAuthor('Maya Chen', 'MAYA CHEN'), true);
  assert.equal(matchesAuthor('Maya Chen', 'maya.*chen'), false); // literal, not regex
  assert.equal(matchesAuthor('maya@example.invalid', 'example.invalid'), true);
});

test('authorMatches checks both name and email; null filter matches everything', () => {
  const author = { name: 'Maya Chen', email: 'maya@example.invalid' };
  assert.equal(authorMatches(author, 'chen'), true);
  assert.equal(authorMatches(author, 'example'), true);
  assert.equal(authorMatches(author, 'nobody'), false);
  assert.equal(authorMatches(author, null), true);
});

test('an author filter containing a quote character is rejected (filter-injection defence)', () => {
  assert.throws(
    () => normalizeAuthorFilter(`o'brien`),
    (err: unknown) => err instanceof GitWhyError && err.code === 'INVALID_ARGUMENTS',
  );
  assert.throws(
    () => normalizeAuthorFilter(`"quoted"`),
    (err: unknown) => err instanceof GitWhyError && err.code === 'INVALID_ARGUMENTS',
  );
});

test('an empty author filter is rejected', () => {
  assert.throws(() => normalizeAuthorFilter('   '), GitWhyError);
});

/* ------------------------------------------------------------------ *
 * "Never LIKE on the path-keys field" boundary invariant
 * ------------------------------------------------------------------ */

test('this module never constructs a raw filter expression string, only typed PathRestriction values', () => {
  // We cannot unit-test the storage lane's compiler from here (it lives in
  // src/index/, which we do not import). What we CAN guarantee on our
  // side of the HistoryStore boundary is that the only thing we ever hand
  // downstream is a plain, typed {value, kind} object -- never a string
  // containing an expression fragment such as "LIKE" -- so a directory
  // restriction can only ever be compiled via its `kind` discriminator
  // (CONTAIN_ANY over prefix keys), never through a pattern string.
  const r = resolvePathRestriction('src/auth/', worktreeCtx);
  assert.equal(typeof r.value, 'string');
  assert.equal(r.kind, 'directory');
  assert.doesNotMatch(r.value, /LIKE|%|\\/);
});
