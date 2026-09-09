/**
 * Compile a user's natural-language query into literal FTS query text.
 *
 * Storage-lane capability-spike finding (decisive, not a documentation
 * guess): Zvec's `matchString` is the literal, safe API -- it never
 * interprets quotes, parentheses, or boolean words as query syntax.
 * `queryString` runs a full parser grammar and can throw or misparse on
 * ordinary natural-language punctuation (`?`, `"`, `-`, `:`, parentheses).
 * `HistoryStore.searchLexical` therefore MUST be implemented in terms of
 * `fts: { matchString: <text we return here> }`, never `queryString`, for
 * text that originated from user input.
 *
 * The seam: `compileFtsQuery` is the one function search.ts calls to turn
 * `SearchRequest.query` into the `queryText` argument of
 * `HistoryStore.searchLexical`. If a future finding changes how terms
 * should be joined or escaped for `matchString`, only this function (and
 * its unit tests) need to change.
 *
 * Also load-bearing per the same spike: the native tokenizer treats
 * camelCase as a single token (`AuthSessionProvider` does not match a
 * search for `Session`). We already solve this on the *index* side by
 * emitting decomposed components into `lexicalText`
 * (`src/history/text.ts`). We solve it symmetrically on the *query* side
 * here, by expanding the query through the same tokenizer before handing
 * it to `matchString`, so a query for a compound identifier still reaches
 * documents that only contain its decomposed parts.
 */
import { tokenizeForLexical } from '../history/text.js';

/**
 * Compile raw user query text into the literal term string to pass as
 * `queryText` to `HistoryStore.searchLexical` (which the store must wrap
 * as `matchString`, never `queryString`). Natural-language punctuation is
 * stripped as token separators here, not interpreted as query syntax.
 */
export function compileFtsQuery(raw: string): string {
  return tokenizeForLexical(raw).join(' ');
}
