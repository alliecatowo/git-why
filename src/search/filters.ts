/**
 * A tested, typed filter builder. User path strings are never passed into
 * a database expression directly: this module resolves and validates raw
 * CLI strings into `PathRestriction`/`SearchFilters` (from `src/types.ts`),
 * and `src/index/` (storage lane, not us) is solely responsible for
 * compiling that typed value into an actual Zvec filter expression.
 *
 * Storage-lane capability-spike findings that shape validation here:
 *  - Zvec's filter grammar has no verified in-literal quote escape. Since
 *    we cannot guarantee safe embedding of a quote character in whatever
 *    expression the store eventually builds, we reject quote characters
 *    in path and author filter values outright rather than attempt to
 *    escape them. This is enforced here, at the boundary, regardless of
 *    how the store compiles the (already-safe) value it receives.
 *  - `LIKE` against an `ARRAY_STRING` field (path match keys) crashes the
 *    process. We never build any expression ourselves, but the `kind`
 *    discriminator on `PathRestriction` is the only signal the store
 *    needs to choose `CONTAIN_ANY` over prefix keys (`directory`) or an
 *    exact/scalar match (`file`) -- never `LIKE`. See the "never LIKE"
 *    test in `test/unit/search/filters.test.ts` for the invariant on our
 *    side of that boundary (we cannot test the store's compiler from here
 *    without importing `src/index/`, which we do not own).
 */
import * as nodePath from 'node:path';
import { GitWhyError, type HistoricalPath, type PathRestriction, type SearchFilters, type StorageFilter } from '../types.js';

/* ------------------------------------------------------------------ *
 * Path restrictions
 * ------------------------------------------------------------------ */

export interface PathResolutionContext {
  /** Absolute worktree root, or null for a bare repository (see `RepositoryIdentity`). */
  readonly repositoryRoot: string | null;
  readonly isBare: boolean;
  /** Absolute directory the restriction is resolved relative to, when relative. */
  readonly cwd: string;
}

const GLOB_METACHARACTER_RE = /[*?[\]]/;

function toPosix(p: string): string {
  return p.split(nodePath.sep).join('/');
}

/**
 * Resolve one raw `--` path argument into a validated `PathRestriction`.
 * Never touches the filesystem: a deleted path or a path that used to be a
 * symlink must resolve the same way as any other historical path, purely
 * from the strings involved.
 */
export function resolvePathRestriction(raw: string, ctx: PathResolutionContext): PathRestriction {
  if (raw.length === 0) {
    throw new GitWhyError('INVALID_PATH_RESTRICTION', 'Path restriction must not be empty.');
  }
  if (raw.includes('"') || raw.includes("'")) {
    throw new GitWhyError(
      'INVALID_PATH_RESTRICTION',
      `Path restriction may not contain quote characters: ${raw}`,
      { hint: 'Quote characters cannot be safely represented in the underlying filter expression.' },
    );
  }
  if (GLOB_METACHARACTER_RE.test(raw) || raw.startsWith(':')) {
    throw new GitWhyError(
      'UNSUPPORTED_PATHSPEC',
      `Unsupported pathspec syntax: ${JSON.stringify(raw)}`,
      { hint: 'Git Why matches literal file paths and directory prefixes only, not glob or magic pathspecs.' },
    );
  }

  const isDirectory = raw.endsWith('/');
  const trimmed = isDirectory ? raw.replace(/\/+$/, '') : raw;
  if (trimmed.length === 0) {
    throw new GitWhyError('INVALID_PATH_RESTRICTION', 'Path restriction must not be empty.');
  }

  let relPosix: string;
  if (ctx.isBare || ctx.repositoryRoot === null) {
    // A bare repository has no worktree: the value is already
    // repository-relative. Normalise the string only; do not stat anything.
    const normalized = nodePath.posix.normalize(toPosix(trimmed));
    if (normalized === '..' || normalized.startsWith('../') || nodePath.posix.isAbsolute(normalized)) {
      throw new GitWhyError('INVALID_PATH_RESTRICTION', `Path restriction escapes the repository root: ${raw}`);
    }
    relPosix = normalized;
  } else {
    const absolute = nodePath.resolve(ctx.cwd, trimmed);
    const rel = nodePath.relative(ctx.repositoryRoot, absolute);
    if (rel === '..' || rel.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(rel)) {
      throw new GitWhyError('INVALID_PATH_RESTRICTION', `Path restriction escapes the repository root: ${raw}`);
    }
    relPosix = toPosix(rel);
  }

  relPosix = relPosix.replace(/^\.\/+/, '');
  if (relPosix.length === 0 || relPosix === '.') {
    throw new GitWhyError('INVALID_PATH_RESTRICTION', 'Path restriction resolves to the repository root itself.');
  }

  return { value: relPosix, kind: isDirectory ? 'directory' : 'file' };
}

/** Reference matching semantics: a literal file path, or a directory prefix. */
export function restrictionMatchesPath(restriction: PathRestriction, candidateDisplayPath: string): boolean {
  if (restriction.kind === 'file') return candidateDisplayPath === restriction.value;
  return candidateDisplayPath === restriction.value || candidateDisplayPath.startsWith(`${restriction.value}/`);
}

/** A hunk/evidence change matches if either its path or its old path (rename source) matches. */
export function restrictionMatchesChange(
  restriction: PathRestriction,
  path: HistoricalPath,
  oldPath: HistoricalPath | null,
): boolean {
  return (
    restrictionMatchesPath(restriction, path.display) ||
    (oldPath !== null && restrictionMatchesPath(restriction, oldPath.display))
  );
}

/** Multiple path restrictions OR together. Empty restriction list means "no restriction" (matches everything). */
export function anyRestrictionMatchesChange(
  restrictions: readonly PathRestriction[],
  path: HistoricalPath,
  oldPath: HistoricalPath | null,
): boolean {
  if (restrictions.length === 0) return true;
  return restrictions.some((r) => restrictionMatchesChange(r, path, oldPath));
}

/** A commit summary matches when any of its changed paths (old or new) satisfies the restriction. */
export function anyRestrictionMatchesSummary(
  restrictions: readonly PathRestriction[],
  changedPaths: readonly { readonly path: HistoricalPath; readonly oldPath: HistoricalPath | null }[],
): boolean {
  if (restrictions.length === 0) return true;
  return changedPaths.some((c) => anyRestrictionMatchesChange(restrictions, c.path, c.oldPath));
}

/* ------------------------------------------------------------------ *
 * Dates (committer time, UTC)
 * ------------------------------------------------------------------ */

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

function isValidCivilDateTime(y: number, mo: number, d: number, h: number, mi: number, s: number): boolean {
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || s > 59) return false;
  const utcMs = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(utcMs);
  return (
    check.getUTCFullYear() === y &&
    check.getUTCMonth() === mo - 1 &&
    check.getUTCDate() === d &&
    check.getUTCHours() === h &&
    check.getUTCMinutes() === mi &&
    check.getUTCSeconds() === s
  );
}

/**
 * Parse a `--after`/`--before` boundary into epoch seconds (UTC, committer
 * time). Accepts `YYYY-MM-DD` (interpreted as that date's UTC midnight) or
 * a full ISO-8601 timestamp with an explicit timezone (`Z` or `±HH:MM`).
 * Locale-dependent or timezone-less formats are rejected: they are
 * ambiguous, and `Date.parse` alone is not a validator (it silently rolls
 * invalid calendar dates like Feb 30 forward rather than rejecting them).
 */
export function parseDateBoundary(raw: string): number {
  const trimmed = raw.trim();

  const dateOnly = DATE_ONLY_RE.exec(trimmed);
  if (dateOnly !== null) {
    const [, ys, mos, ds] = dateOnly;
    const y = Number(ys);
    const mo = Number(mos);
    const d = Number(ds);
    if (!isValidCivilDateTime(y, mo, d, 0, 0, 0)) {
      throw new GitWhyError('INVALID_DATE', `Invalid calendar date: ${raw}`);
    }
    return Math.floor(Date.UTC(y, mo - 1, d, 0, 0, 0) / 1000);
  }

  const dateTime = DATE_TIME_RE.exec(trimmed);
  if (dateTime !== null) {
    const [, ys, mos, ds, hs, mis, ss, tz] = dateTime;
    const y = Number(ys);
    const mo = Number(mos);
    const d = Number(ds);
    const h = Number(hs);
    const mi = Number(mis);
    const s = Number(ss);
    if (!isValidCivilDateTime(y, mo, d, h, mi, s)) {
      throw new GitWhyError('INVALID_DATE', `Invalid calendar date/time: ${raw}`);
    }
    const offsetMinutes =
      tz === 'Z'
        ? 0
        : (tz!.startsWith('-') ? -1 : 1) * (Number(tz!.slice(1, 3)) * 60 + Number(tz!.slice(4, 6)));
    const utcMs = Date.UTC(y, mo - 1, d, h, mi, s) - offsetMinutes * 60_000;
    return Math.floor(utcMs / 1000);
  }

  throw new GitWhyError('INVALID_DATE', `Unsupported date format: ${raw}`, {
    hint: 'Use YYYY-MM-DD or an ISO-8601 timestamp with an explicit timezone (Z or +HH:MM/-HH:MM).',
  });
}

/* ------------------------------------------------------------------ *
 * Author
 * ------------------------------------------------------------------ */

/**
 * Validate and normalise a raw `--author` value. Case folding happens at
 * match time (`matchesAuthor`), not here, so the original bytes remain
 * available for display in error messages/echoes.
 */
export function normalizeAuthorFilter(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new GitWhyError('INVALID_ARGUMENTS', '--author must not be empty.');
  }
  if (trimmed.includes('"') || trimmed.includes("'")) {
    throw new GitWhyError('INVALID_ARGUMENTS', '--author may not contain quote characters.', {
      hint: 'Quote characters cannot be safely represented in the underlying filter expression.',
    });
  }
  return trimmed;
}

/** Case-insensitive literal substring match against the original author name or email. Never a regex, no `.mailmap`. */
export function matchesAuthor(nameOrEmail: string, filterSubstring: string): boolean {
  return nameOrEmail.toLowerCase().includes(filterSubstring.toLowerCase());
}

export function authorMatches(
  author: { readonly name: string; readonly email: string },
  filterSubstring: string | null,
): boolean {
  if (filterSubstring === null) return true;
  return matchesAuthor(author.name, filterSubstring) || matchesAuthor(author.email, filterSubstring);
}

/* ------------------------------------------------------------------ *
 * Storage filter assembly
 * ------------------------------------------------------------------ */

export function buildStorageFilter(
  filters: SearchFilters,
  recordTypes: readonly ('commit' | 'evidence')[],
): StorageFilter {
  return { recordTypes, filters };
}
