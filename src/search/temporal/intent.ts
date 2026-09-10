/**
 * Query decomposition: split a question into a temporally neutral core and a
 * temporal constraint.
 *
 * The core is what the retrieval branches actually see. Timestamps are never
 * embedded and the temporal phrasing is stripped before embedding, because
 * "when was X first introduced" and "X" should find the same topic -- the
 * words "when", "first" and "introduced" are instructions about ordering, not
 * content, and leaving them in the embedded text pulls the vector towards
 * commits that happen to talk about introductions.
 *
 * This is rule-based on purpose. A model here would be a second thing to
 * evaluate and a second thing to go wrong, and the phrasing space for "when
 * did this happen" questions is small and highly conventional.
 */

import {
  NO_TEMPORAL_CONSTRAINT,
  type QueryDecomposition,
  type TemporalAnchor,
  type TemporalConfidence,
  type TemporalConstraint,
  type TemporalConstraintType,
} from '../../types.js';

/** CLI/MCP flags that state a constraint outright, bypassing the parser. */
export interface TemporalFlags {
  readonly first?: boolean;
  readonly last?: boolean;
  readonly removed?: boolean;
  readonly timeline?: boolean;
  readonly before?: string;
  readonly after?: string;
  /** "a,b" -- already split by the caller. */
  readonly between?: readonly [string, string];
  readonly around?: string;
}

const SHA_RE = /^[0-9a-f]{7,40}$/i;
/** v1.2, v1.2.3, 1.18.30, 2.0 -- release-ish, not a bare year. */
const TAG_RE = /^v?\d+\.\d+(?:\.\d+)?(?:[-.][0-9A-Za-z.-]+)?$/;
const ISO_DATE_RE = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/;

const MONTHS: Readonly<Record<string, number>> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

const MONTH_NAME_RE = new RegExp(`^(${Object.keys(MONTHS).join('|')})\\s+(\\d{4})$`, 'i');
const RELATIVE_RE = /^(?:(last|past)\s+)?(year|month|week)$/i;

const SECONDS = { week: 604800, month: 2629746, year: 31556952 } as const;

/**
 * Parses an anchor string into the union. Order matters: a SHA test must come
 * before the tag test, since "1234567" is both a valid abbreviated SHA and a
 * plausible number, and a SHA is the more specific reading of a hex string.
 */
export function parseAnchor(raw: string, now: number = Date.now()): TemporalAnchor {
  const trimmed = raw.trim();

  if (SHA_RE.test(trimmed) && /[a-f]/i.test(trimmed)) {
    return { kind: 'sha', raw: trimmed, sha: trimmed.toLowerCase() };
  }

  const iso = ISO_DATE_RE.exec(trimmed);
  if (iso) {
    const [, y, m, d] = iso;
    const epochSeconds = Math.floor(
      Date.UTC(Number(y), Number(m) - 1, d === undefined ? 1 : Number(d)) / 1000,
    );
    return { kind: 'date', raw: trimmed, epochSeconds };
  }

  const monthName = MONTH_NAME_RE.exec(trimmed);
  if (monthName) {
    const month = MONTHS[monthName[1]!.toLowerCase()]!;
    const epochSeconds = Math.floor(Date.UTC(Number(monthName[2]), month, 1) / 1000);
    return { kind: 'date', raw: trimmed, epochSeconds };
  }

  const relative = RELATIVE_RE.exec(trimmed);
  if (relative) {
    const unit = relative[2]!.toLowerCase() as keyof typeof SECONDS;
    return {
      kind: 'date',
      raw: trimmed,
      epochSeconds: Math.floor(now / 1000) - SECONDS[unit],
    };
  }

  // A bare four-digit year, but only in a plausible range: "3000" is far more
  // likely a magic number from the codebase than a year the user means.
  if (/^\d{4}$/.test(trimmed)) {
    const year = Number(trimmed);
    if (year >= 1970 && year <= 2100) {
      return { kind: 'date', raw: trimmed, epochSeconds: Math.floor(Date.UTC(year, 0, 1) / 1000) };
    }
  }

  if (TAG_RE.test(trimmed)) return { kind: 'tag', raw: trimmed, name: trimmed };

  // Everything else is a question about history -- "we migrated to the new
  // client" -- and is resolved later by a nested hybrid search.
  return { kind: 'query', raw: trimmed, query: trimmed };
}

function constraint(
  type: TemporalConstraintType,
  confidence: TemporalConfidence,
  anchor: TemporalAnchor | null = null,
  anchorEnd: TemporalAnchor | null = null,
): TemporalConstraint {
  return { type, confidence, anchor, anchorEnd };
}

/**
 * Builds an explicit constraint from flags. Flags are always `explicit`: the
 * user typed `--first`, there is nothing to infer.
 *
 * Returns null when no temporal flag is set, so the caller can fall back to
 * parsing the query text.
 */
export function constraintFromFlags(
  flags: TemporalFlags,
  now: number = Date.now(),
): TemporalConstraint | null {
  if (flags.first === true) return constraint('first', 'explicit');
  if (flags.last === true) return constraint('last', 'explicit');
  if (flags.removed === true) return constraint('removed', 'explicit');
  if (flags.timeline === true) return constraint('timeline', 'explicit');
  if (flags.between !== undefined) {
    return constraint(
      'between',
      'explicit',
      parseAnchor(flags.between[0], now),
      parseAnchor(flags.between[1], now),
    );
  }
  if (flags.before !== undefined) {
    return constraint('before', 'explicit', parseAnchor(flags.before, now));
  }
  if (flags.after !== undefined) {
    return constraint('after', 'explicit', parseAnchor(flags.after, now));
  }
  if (flags.around !== undefined) {
    return constraint('around', 'explicit', parseAnchor(flags.around, now));
  }
  return null;
}

/**
 * A pattern that recognises one phrasing family.
 *
 * `strip` removes the temporal wording from the query to leave the core.
 * `confidence` records whether the phrasing is unambiguous. Being honest here
 * matters more than coverage: an over-eager `explicit` applies exponent 1.0 to
 * a guess, and the survey literature is clear that implicit temporal questions
 * are the hardest class to detect. When in doubt the rule says `inferred`.
 */
interface Rule {
  readonly type: TemporalConstraintType;
  readonly confidence: TemporalConfidence;
  readonly test: RegExp;
  /** Captures an anchor from group 1 when present. */
  readonly anchored?: boolean;
}

const RULES: readonly Rule[] = [
  // --- removed: checked before `first`, because "when was the X workaround
  // --- removed" also contains no "first" but "why was X first removed" would
  // --- otherwise match the introduction family on the word "first".
  {
    type: 'removed',
    confidence: 'explicit',
    test: /\b(?:when|why)\s+(?:was|were|did)\s+.*\b(?:removed|deleted|dropped|deprecated|taken\s+out)\b/i,
  },
  {
    type: 'removed',
    confidence: 'explicit',
    test: /\bwhen\s+did\s+(?:we|they|someone)\s+(?:remove|delete|drop|deprecate)\b/i,
  },
  { type: 'removed', confidence: 'inferred', test: /\b(?:removal|deletion)\s+of\b/i },

  // --- first / introduction
  {
    type: 'first',
    confidence: 'explicit',
    test: /\bwhen\s+(?:was|were)\s+.*\bfirst\b.*\b(?:introduced|added|implemented|written|created)\b/i,
  },
  {
    type: 'first',
    confidence: 'explicit',
    test: /\bwhen\s+(?:was|were)\s+.*\b(?:introduced|added|implemented|created)\b/i,
  },
  {
    type: 'first',
    confidence: 'explicit',
    test: /\bwhen\s+did\s+(?:we|they|someone)\s+(?:first\s+)?(?:add|introduce|implement|create|start\s+using)\b/i,
  },
  { type: 'first', confidence: 'explicit', test: /\bfirst\s+(?:introduced|added|appeared)\b/i },
  { type: 'first', confidence: 'inferred', test: /\b(?:origin|origins|genesis)\s+of\b/i },
  { type: 'first', confidence: 'inferred', test: /\bwhere\s+did\s+.*\bcome\s+from\b/i },

  // --- last
  {
    type: 'last',
    confidence: 'explicit',
    test: /\bwhen\s+(?:was|were)\s+.*\blast\s+(?:changed|modified|touched|updated|edited)\b/i,
  },
  {
    type: 'last',
    confidence: 'explicit',
    test: /\b(?:most\s+recent|latest)\s+(?:change|modification|update)\s+to\b/i,
  },

  // --- timeline: before `changed_when`, since "how did X change over time"
  // --- reads as a history request, not a point-in-time question.
  {
    type: 'timeline',
    confidence: 'explicit',
    test: /\b(?:history|evolution|timeline)\s+of\b/i,
  },
  {
    type: 'timeline',
    confidence: 'explicit',
    test: /\bhow\s+(?:did|has)\s+.*\b(?:evolve|evolved|change[d]?\s+over\s+time|develop[ed]?\s+over\s+time)\b/i,
  },
  { type: 'timeline', confidence: 'inferred', test: /\ball\s+the\s+changes\s+to\b/i },

  // --- changed_when
  {
    type: 'changed_when',
    confidence: 'explicit',
    test: /\bwhen\s+did\s+.*\bchange\b/i,
  },
  {
    type: 'changed_when',
    confidence: 'explicit',
    test: /\bwhen\s+(?:was|were)\s+.*\bchanged\b/i,
  },

  // --- relative, anchored
  { type: 'before', confidence: 'explicit', anchored: true, test: /\bbefore\s+(.+)$/i },
  { type: 'after', confidence: 'explicit', anchored: true, test: /\b(?:after|since)\s+(.+)$/i },
  { type: 'around', confidence: 'explicit', anchored: true, test: /\baround\s+(.+)$/i },
];

const BETWEEN_RE = /\bbetween\s+(\S+)\s+and\s+(\S+)/i;

/**
 * Words that carry ordering rather than content. Removed from the core so the
 * embedded text describes the topic only.
 */
const TEMPORAL_NOISE =
  /\b(?:when|first|last|originally|initially|ever|was|were|did|does|do|the|a|an)\b/gi;

const LEADING_INTERROGATIVE =
  /^(?:when|why|how|where|what|show\s+me|tell\s+me|give\s+me|find|list)\b[\s,]*/i;

/** Collapses the whitespace left behind by stripping words. */
function tidy(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.:;-]+|[\s,.:;?!-]+$/g, '')
    .trim();
}

/**
 * Strips temporal scaffolding to leave the topic.
 *
 * Conservative by design: if stripping would leave almost nothing, the
 * original query is kept. An empty or near-empty core retrieves noise, which
 * is strictly worse than retrieving with a few extra function words.
 */
function coreOf(query: string, matched: RegExpExecArray | null): string {
  let core = query;

  // Drop the matched temporal clause itself when it is a trailing anchor
  // phrase ("... before the v2 migration"), since the anchor is captured
  // separately and would otherwise be embedded twice.
  if (matched !== null && matched.index > 0) {
    core = query.slice(0, matched.index);
  }

  core = core.replace(LEADING_INTERROGATIVE, '');
  core = core.replace(
    /\b(?:introduced|added|implemented|created|removed|deleted|dropped|deprecated|changed|modified|touched|updated|history|evolution|timeline)\b/gi,
    '',
  );
  core = core.replace(TEMPORAL_NOISE, '');
  core = tidy(core);

  const stripped = tidy(query.replace(LEADING_INTERROGATIVE, ''));
  if (core.length < 3) return stripped.length >= 3 ? stripped : query;
  return core;
}

/**
 * Splits a raw query into its core and constraint.
 *
 * For a query with no temporal phrasing the core is the input string
 * unchanged, character for character, and the constraint is exactly
 * `NO_TEMPORAL_CONSTRAINT`. That identity is what guarantees ordinary queries
 * rank exactly as they did before the temporal layer existed, so it is
 * asserted directly in the tests rather than left as an emergent property.
 */
export function decomposeQuery(query: string, now: number = Date.now()): QueryDecomposition {
  const between = BETWEEN_RE.exec(query);
  if (between !== null) {
    return {
      core: coreOf(query, between),
      constraint: {
        type: 'between',
        confidence: 'explicit',
        anchor: parseAnchor(between[1]!, now),
        anchorEnd: parseAnchor(between[2]!, now),
      },
    };
  }

  for (const rule of RULES) {
    const matched = rule.test.exec(query);
    if (matched === null) continue;

    const anchor =
      rule.anchored === true && matched[1] !== undefined ? parseAnchor(matched[1], now) : null;

    return {
      core: coreOf(query, rule.anchored === true ? matched : null),
      constraint: { type: rule.type, confidence: rule.confidence, anchor, anchorEnd: null },
    };
  }

  return { core: query, constraint: NO_TEMPORAL_CONSTRAINT };
}
