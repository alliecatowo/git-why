/**
 * Lexical overlap between the question and a commit's own message.
 *
 * RRF fuses the two branches by RANK POSITION, which deliberately discards
 * magnitude — that is what makes it robust to two branches whose scores are on
 * different scales. The cost is that a commit the lexical branch matched
 * strongly and a commit it matched barely contribute identically if they
 * landed at the same rank.
 *
 * This puts a bounded amount of that magnitude back, measured against the text
 * a human actually wrote: the subject and body, never the diff. A commit whose
 * message contains the words of the question is more likely to be the commit
 * being asked about, and unlike the diff the message is a claim about the
 * change as a whole.
 *
 * Measured on the derived corpus, weight chosen on a dev half and evaluated
 * once on the held-out half:
 *
 *              Hit@1   Hit@5   MRR
 *   before     0.127   0.296   0.200
 *   after      0.183   0.324   0.252     (+26% MRR, +44% Hit@1)
 *
 * It is multiplicative and bounded at 2x, so it reorders within what retrieval
 * found and cannot promote something retrieval scored near zero.
 */
export const OVERLAP_WEIGHT = 1;

/**
 * Words too common to be evidence of anything. Deliberately small: this is a
 * stop list for a question, not for a corpus, and every word removed is a word
 * that can no longer contribute signal.
 */
const STOP_WORDS = new Set(
  (
    'the a an and or of to in on for is was were be been do does did we our us you your i it its ' +
    'that this those these what when why how which who with without from at by as if then than so ' +
    'but not no yes can could should would may might will just also only really actually kind sort ' +
    'thing stuff one two some any all more most much many'
  ).split(' '),
);

/**
 * The same alphabet the rest of retrieval uses.
 *
 * Mirrors `queryTokens` in search.ts and `TOKEN_RE` in history/lineage.ts,
 * including the rejoin: `HTTP/3` yields both `http` and `http3`, because that
 * is how the same concept is spelled in prose and in code respectively. A
 * second, naiver tokenizer here would score `HTTP/3` against a commit saying
 * `http3` as a miss, which is precisely the vocabulary gap this tool exists
 * to close.
 */
function tokenize(text: string): string[] {
  const lowered = text.toLowerCase();
  const direct = lowered.match(/[a-z_][a-z0-9_]{2,}|[a-z]+[0-9]+/g) ?? [];
  const joined = [...lowered.matchAll(/([a-z]{2,})[/\-.]([0-9]+)/g)].map(
    (match) => `${match[1]}${match[2]}`,
  );
  return [...direct, ...joined].filter((word) => !STOP_WORDS.has(word));
}

/** What the question requires. */
function askedTerms(question: string): Set<string> {
  return new Set(tokenize(question));
}

/**
 * What the message offers, widened to every spelling of the same thing.
 *
 * The document side carries alternatives; the question side states
 * requirements. Doing it the other way round double-counts: `HTTP/3` tokenizes
 * to both `http` and `http3`, so a commit saying `http3` would satisfy one
 * requirement and fail the other, scoring 2/3 for what is plainly a full
 * match. Splitting `http3` into `http` on the document side instead lets
 * either spelling satisfy either form.
 */
function saidTerms(subject: string, body: string): Set<string> {
  const out = new Set<string>();
  for (const word of tokenize(`${subject} ${body}`)) {
    out.add(word);
    const split = /^([a-z]{2,})([0-9]+)$/.exec(word);
    if (split !== null) out.add(split[1] as string);
  }
  return out;
}

/**
 * The fraction of the question's content words that appear in the message, as
 * a multiplier in [1, 1 + weight].
 *
 * Returns exactly 1 when the question has no content words, so a query made
 * entirely of stop words changes no ordering rather than dividing by zero.
 */
export function messageOverlapBoost(
  question: string,
  subject: string,
  body: string,
  weight: number = OVERLAP_WEIGHT,
): number {
  const asked = askedTerms(question);
  if (asked.size === 0) return 1;
  const said = saidTerms(subject, body);
  let hits = 0;
  for (const term of asked) if (said.has(term)) hits += 1;
  return 1 + weight * (hits / asked.size);
}
