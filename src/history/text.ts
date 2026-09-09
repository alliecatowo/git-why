/**
 * Three strictly separate text concepts (spec section 9):
 *
 *  - source excerpt: faithful, displayable historical evidence. Never
 *    normalised, never rewritten -- only clipped to a byte budget with a
 *    flag recording that it happened.
 *  - semantic text: input to the embedding model, budgeted with the
 *    model's *actual* tokenizer (never a character heuristic), with
 *    explicit labels for removed/added code because small static
 *    embeddings do not reliably represent direction carried by bare
 *    `-`/`+` prefixes.
 *  - lexical text: normalised for keyword retrieval: retains every
 *    original token and adds camelCase/snake_case/path/version
 *    components, without ever discarding the originals.
 *
 * Nothing in this module may write into `sourceExcerpt` from normalised
 * text, and nothing may skip token-budgeting in favour of `.length`.
 */
import type { ChangeType, Embedder, HistoricalPath } from '../types.js';
import { messageTokenBudget, semanticBudgetFor } from './policy.js';

/* ------------------------------------------------------------------ *
 * Lexical normalisation
 * ------------------------------------------------------------------ */

// Identifier-ish runs: letters, digits, underscore, dot, slash, hyphen.
// Everything else (natural-language punctuation, quotes, whitespace) is a
// separator and is discarded -- but never a character *inside* a run.
const RAW_TOKEN_RE = /[A-Za-z0-9_./-]+/g;
const CAMEL_BOUNDARY_RE = /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/g;

function splitCamel(token: string): string[] {
  if (token.length === 0) return [];
  return token.split(CAMEL_BOUNDARY_RE).filter((p) => p.length > 0);
}

/** Split on `_` and `-`, then further split each part on camelCase boundaries. */
function splitWordParts(token: string): string[] {
  const parts: string[] = [];
  for (const part of token.split(/[_-]+/).filter((p) => p.length > 0)) {
    parts.push(...splitCamel(part));
  }
  return parts;
}

/**
 * Expand one raw identifier/path/version-like token into the full set of
 * searchable forms: the original verbatim, plus path segments, plus
 * extension/version dot-parts, plus camelCase/snake_case components.
 * Numbers are always kept as-is; never merged, rounded or hashed.
 */
function expandToken(raw: string): string[] {
  const out = new Set<string>();
  out.add(raw);

  const pathSegments = raw.split('/').filter((s) => s.length > 0);
  if (pathSegments.length > 1) {
    for (const seg of pathSegments) out.add(seg);
  }

  for (const seg of pathSegments.length > 0 ? pathSegments : [raw]) {
    out.add(seg);
    const dotParts = seg.split('.').filter((p) => p.length > 0);
    if (dotParts.length > 1) {
      for (const p of dotParts) out.add(p);
    }
    for (const p of dotParts.length > 0 ? dotParts : [seg]) {
      for (const w of splitWordParts(p)) out.add(w);
    }
  }

  // Case-folded duplicates for engines that do not fold case themselves.
  // The original-case token above is always preserved alongside these.
  for (const t of [...out]) {
    const lower = t.toLowerCase();
    if (lower !== t) out.add(lower);
  }

  return [...out];
}

/**
 * Normalise free text for keyword retrieval: every original token
 * survives, plus decomposed identifier/path/version components.
 * Order-preserving, de-duplicated.
 */
export function tokenizeForLexical(text: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const rawTokens = text.match(RAW_TOKEN_RE) ?? [];
  for (const raw of rawTokens) {
    for (const expanded of expandToken(raw)) {
      if (!seen.has(expanded)) {
        seen.add(expanded);
        ordered.push(expanded);
      }
    }
  }
  return ordered;
}

export function normalizeLexicalText(text: string): string {
  return tokenizeForLexical(text).join(' ');
}

/* ------------------------------------------------------------------ *
 * Byte-budgeted clipping (source excerpt)
 * ------------------------------------------------------------------ */

export interface ClipResult {
  readonly text: string;
  readonly clipped: boolean;
}

/** Clip to at most `maxBytes` UTF-8 bytes, never splitting a multi-byte character. */
export function clipToBytes(text: string, maxBytes: number): ClipResult {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { text, clipped: false };
  let end = maxBytes;
  // Back off until we land on a UTF-8 character boundary (continuation
  // bytes have the high bits `10`).
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
  return { text: buf.subarray(0, end).toString('utf8'), clipped: true };
}

/* ------------------------------------------------------------------ *
 * Commit-level semantic / lexical text
 * ------------------------------------------------------------------ */

export interface CommitTextInput {
  readonly subject: string;
  readonly body: string;
  /** Full, normalised display paths -- already deduplicated by caller if desired. */
  readonly changedPathDisplays: readonly string[];
}

export interface BuiltText {
  readonly semanticText: string;
  readonly lexicalText: string;
  /** True when the semantic text had to drop material to fit the token budget. */
  readonly semanticTruncated: boolean;
}

function messageBlock(subject: string, body: string): string {
  return body.length > 0 ? `${subject}\n\n${body}` : subject;
}

export function buildCommitText(
  input: CommitTextInput,
  embedder: Embedder,
  maxChangedPaths: number,
): BuiltText {
  const totalBudget = semanticBudgetFor(embedder.maxInputTokens);
  const msgBudget = messageTokenBudget(totalBudget);

  const fullMessage = messageBlock(input.subject, input.body);
  const messagePart = embedder.truncateToTokens(fullMessage, msgBudget);
  const messageTokensUsed = embedder.countTokens(messagePart);

  const shownPaths = input.changedPathDisplays.slice(0, maxChangedPaths);
  const pathsBlock = shownPaths.length > 0 ? `Changed files:\n${shownPaths.join('\n')}` : '';

  const remaining = Math.max(0, totalBudget - messageTokensUsed);
  const pathsPart = embedder.truncateToTokens(pathsBlock, remaining);

  let semanticText = pathsPart.length > 0 ? `${messagePart}\n\n${pathsPart}` : messagePart;
  const beforeFinalClamp = embedder.countTokens(semanticText);
  semanticText = embedder.truncateToTokens(semanticText, totalBudget);
  const semanticTruncated =
    embedder.countTokens(fullMessage) > messageTokensUsed ||
    pathsBlock.length > pathsPart.length ||
    embedder.countTokens(semanticText) < beforeFinalClamp;

  const lexicalSource = [input.subject, input.body, ...input.changedPathDisplays].join('\n');
  const lexicalText = normalizeLexicalText(lexicalSource);

  return { semanticText, lexicalText, semanticTruncated };
}

/* ------------------------------------------------------------------ *
 * Hunk-level semantic / lexical text
 * ------------------------------------------------------------------ */

export interface HunkTextInput {
  readonly subject: string;
  readonly body: string;
  readonly path: HistoricalPath;
  readonly oldPath: HistoricalPath | null;
  readonly changeType: ChangeType;
  readonly removedLines: readonly string[];
  readonly addedLines: readonly string[];
  readonly contextLines: readonly string[];
}

const CHANGE_TYPE_LABEL: Record<ChangeType, string> = {
  A: 'added',
  C: 'copied',
  D: 'deleted',
  M: 'modified',
  R: 'renamed',
  T: 'type changed',
  U: 'unmerged',
  X: 'unknown',
};

export function buildHunkText(input: HunkTextInput, embedder: Embedder): BuiltText {
  const totalBudget = semanticBudgetFor(embedder.maxInputTokens);
  const msgBudget = messageTokenBudget(totalBudget);

  const fullMessage = messageBlock(input.subject, input.body);
  const messagePart = embedder.truncateToTokens(fullMessage, msgBudget);

  const renamedNote =
    input.oldPath !== null && input.oldPath.display !== input.path.display
      ? ` (renamed from ${input.oldPath.display})`
      : '';
  const fixedPrefix = [
    `Commit: ${messagePart}`,
    `File: ${input.path.display}${renamedNote}`,
    `Change: ${CHANGE_TYPE_LABEL[input.changeType]}`,
  ].join('\n');

  const usedTokens = embedder.countTokens(fixedPrefix);
  const codeBudget = Math.max(0, totalBudget - usedTokens);

  const codeSections: string[] = [];
  if (input.removedLines.length > 0) {
    codeSections.push(`Removed code:\n${input.removedLines.join('\n')}`);
  }
  if (input.addedLines.length > 0) {
    codeSections.push(`Added code:\n${input.addedLines.join('\n')}`);
  }
  const codeText = codeSections.join('\n');
  const codePart = embedder.truncateToTokens(codeText, codeBudget);

  let semanticText = codePart.length > 0 ? `${fixedPrefix}\n${codePart}` : fixedPrefix;
  const beforeFinalClamp = embedder.countTokens(semanticText);
  semanticText = embedder.truncateToTokens(semanticText, totalBudget);

  const semanticTruncated =
    embedder.countTokens(fullMessage) > embedder.countTokens(messagePart) ||
    codeText.length > codePart.length ||
    embedder.countTokens(semanticText) < beforeFinalClamp;

  const lexicalSource = [
    input.subject,
    input.body,
    input.path.display,
    input.oldPath?.display ?? '',
    ...input.contextLines,
    ...input.removedLines,
    ...input.addedLines,
  ].join('\n');
  const lexicalText = normalizeLexicalText(lexicalSource);

  return { semanticText, lexicalText, semanticTruncated };
}
