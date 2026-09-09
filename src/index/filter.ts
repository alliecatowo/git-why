/**
 * Zvec filter-expression construction. The grammar itself is undocumented
 * in the package; every rule encoded here was reverse-engineered by
 * `spike/run.ts` and is recorded in docs/decisions.md section 3. Do not
 * "clean up" this file based on assumptions about SQL — several ordinary
 * SQL forms (`==`, `&&`, bare `NOT`, `BETWEEN`) do not parse here.
 */

import type { PathRestriction, SearchFilters } from '../types.js';
import { GitWhyError } from '../types.js';

/**
 * Quote a string literal for the filter grammar. Both `'...'` and `"..."`
 * are accepted as delimiters, but no in-literal escape of the quote
 * character itself was found to work (neither doubling nor backslash).
 * Pick whichever delimiter is absent from the value; if both appear,
 * there is no proven-safe encoding, so this throws rather than emit a
 * filter expression an attacker-controlled value could break out of.
 */
export function quoteFilterLiteral(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  throw new GitWhyError(
    'INTERNAL',
    `cannot safely quote a filter literal containing both quote characters: ${JSON.stringify(value)}`,
  );
}

/**
 * Build a `LIKE '%...%'` substring pattern, escaping the LIKE wildcard
 * characters (`%`, `_`) and the escape character itself with a backslash
 * — verified to work against this build (docs/decisions.md section 3).
 */
export function likeSubstringPattern(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
  return quoteFilterLiteral(`%${escaped}%`);
}

/** Directory segment characters that would break a CONTAIN_ANY string literal are stripped upstream (see stripQuotesForIndexing). */
export function stripQuotesForIndexing(value: string): string {
  return value.replace(/['"]/g, '');
}

/**
 * Match keys for a historical path: the full normalized path plus every
 * directory prefix (spec section 8). Both file and directory
 * `PathRestriction`s are matched against this same array via
 * `CONTAIN_ANY`, since directory prefixes are included alongside the full
 * path.
 */
export function pathMatchKeys(displayPath: string): string[] {
  const clean = stripQuotesForIndexing(displayPath);
  const segments = clean.split('/').filter((s) => s.length > 0);
  const keys: string[] = [];
  if (segments.length === 0) return keys;
  keys.push(segments.join('/'));
  for (let i = segments.length - 1; i > 0; i--) {
    keys.push(segments.slice(0, i).join('/'));
  }
  return keys;
}

function containAnyExpr(field: string, values: readonly string[]): string | null {
  if (values.length === 0) return null;
  const literals = values.map((v) => quoteFilterLiteral(stripQuotesForIndexing(v)));
  return `${field} CONTAIN_ANY(${literals.join(', ')})`;
}

function pathRestrictionValues(paths: readonly PathRestriction[]): string[] {
  return paths.map((p) => p.value);
}

export interface EligibilityFieldNames {
  readonly type: string;
  readonly committerTime: string;
  readonly authorSearch: string;
  readonly pathKeys: string;
}

/**
 * Build the combined eligibility filter expression for a `StorageFilter` +
 * `SearchFilters`. Returns `undefined` when there is nothing to filter on
 * (an absent `filter` is valid on `ZVecQuery`).
 */
export function buildEligibilityExpression(
  fields: EligibilityFieldNames,
  recordTypes: readonly ('commit' | 'evidence')[],
  filters: SearchFilters,
): string | undefined {
  const clauses: string[] = [];

  if (recordTypes.length === 1) {
    clauses.push(`${fields.type} = ${quoteFilterLiteral(recordTypes[0]!)}`);
  } else if (recordTypes.length > 1) {
    const literals = recordTypes.map((t) => quoteFilterLiteral(t));
    clauses.push(`${fields.type} IN (${literals.join(', ')})`);
  }

  if (filters.after !== null)
    clauses.push(`${fields.committerTime} >= ${Math.trunc(filters.after)}`);
  if (filters.before !== null)
    clauses.push(`${fields.committerTime} < ${Math.trunc(filters.before)}`);

  if (filters.author !== null && filters.author.length > 0) {
    clauses.push(
      `${fields.authorSearch} LIKE ${likeSubstringPattern(filters.author.toLowerCase())}`,
    );
  }

  if (filters.paths.length > 0) {
    const expr = containAnyExpr(fields.pathKeys, pathRestrictionValues(filters.paths));
    if (expr !== null) clauses.push(expr);
  }

  if (clauses.length === 0) return undefined;
  return clauses.join(' AND ');
}
