/**
 * Pseudo-relevance feedback: bridge the vocabulary gap between how a person
 * asks and how a commit is written.
 *
 * Measured on the derived corpus, recall@50 was FLAT against recall@20 at
 * 0.250 -- widening the result window recovered nothing, because in three
 * quarters of cases the right commit never entered the candidate pool at all.
 * That makes it a retrieval failure rather than a ranking one, and re-ranking,
 * RRF tuning or score penalties can only ever reorder the quarter that did
 * get retrieved.
 *
 * The cause is vocabulary. A developer asks "why did making lots of schemas
 * suddenly get so slow and memory-hungry"; the commit says "instances carried
 * their methods as own properties". Almost no terms overlap, so the lexical
 * branch cannot match and a small static embedder struggles to bridge it.
 *
 * PRF is the standard answer and needs no new model: take the top few results
 * of a first pass, harvest the distinctive terms they actually use, and search
 * again with those added. The first pass does not need to be right -- it only
 * needs to be in the right neighbourhood for the vocabulary to be useful,
 * which is a much weaker requirement than ranking correctly.
 */

/** Words too common to discriminate, plus the question-framing vocabulary. */
const STOP = new Set(
  (
    'the a an and or but for with that this from into when what which why how does do did is are was were ' +
    'be been being have has had will would should could can may might must not no yes if then else than ' +
    'there their they them it its our we you your used using still able only ever after before some thing ' +
    'stuff happened issue problem bug where suddenly kept made make making got get been also just very ' +
    'more most much many such same other than then now here about over under between during while'
  ).split(/\s+/),
);

/** Terms already in the query contribute nothing when added back to it. */
function contentTerms(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) ?? []).filter((w) => !STOP.has(w));
}

export interface ExpansionSource {
  /** Text of a highly-ranked candidate: commit message, evidence excerpt. */
  readonly text: string;
  /** Rank position, 0-based. Earlier documents are weighted more heavily. */
  readonly rank: number;
}

/**
 * Chooses expansion terms from the top documents of a first pass.
 *
 * Scoring is deliberately simple: a term is worth adding when it appears in
 * SEVERAL top documents rather than many times in one. A term that saturates a
 * single document is usually that document's idiosyncrasy -- a filename, a
 * contributor's name -- and adding it drags the second pass toward that one
 * document instead of toward the topic.
 */
export function selectExpansionTerms(
  sources: readonly ExpansionSource[],
  queryText: string,
  maxTerms = 8,
): string[] {
  const inQuery = new Set(contentTerms(queryText));
  const documentCount = new Map<string, number>();
  const weight = new Map<string, number>();

  for (const source of sources) {
    // Rank decay: the first result's vocabulary is more trustworthy than the
    // fifth's, but not by so much that later ones are ignored.
    const rankWeight = 1 / (1 + source.rank);
    for (const term of new Set(contentTerms(source.text))) {
      if (inQuery.has(term)) continue;
      documentCount.set(term, (documentCount.get(term) ?? 0) + 1);
      weight.set(term, (weight.get(term) ?? 0) + rankWeight);
    }
  }

  return [...weight.entries()]
    .filter(([term]) => (documentCount.get(term) ?? 0) >= 2 && term.length >= 4)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxTerms)
    .map(([term]) => term);
}

/**
 * Builds the second-pass query.
 *
 * The original question is kept verbatim and the harvested terms are appended.
 * Replacing it would throw away the one thing known to be correct -- what the
 * user actually asked -- in favour of terms inferred from results that may be
 * wrong.
 */
export function expandQuery(original: string, terms: readonly string[]): string {
  if (terms.length === 0) return original;
  return `${original} ${terms.join(' ')}`;
}
