/**
 * Every tunable constant in the temporal layer, in one file on purpose.
 *
 * These are tuned on `bench/dataset/dev.json` ONLY. The held-out split must
 * never inform a number in this file; if it ever does, the holdout is burned
 * and a new one has to be constructed before any further claim is made.
 *
 * Keeping them together is not tidiness. A temporal scoring function whose
 * constants are scattered through the code cannot be re-tuned honestly,
 * because there is no way to enumerate what was fitted.
 */

/**
 * Exponent applied to the temporal term: `final = fused * temporal ** w`.
 *
 * Confidence scales the exponent rather than gating the term. A misparsed
 * intent then costs rank instead of destroying the result set, which matters
 * because rule-based intent detection is wrong some of the time by
 * construction. `none` is exactly 0 so that `temporal ** 0 === 1` and the
 * multiplication is a provable no-op.
 */
export const EXPONENT = {
  explicit: 1.0,
  inferred: 0.5,
  none: 0,
} as const;

/**
 * Decay per ordinal position for `first` / `last` / `removed`.
 *
 * A smooth geometric decay, not a cliff. Ancestry ordering can be genuinely
 * ambiguous across parallel branches, so the second-earliest candidate must
 * stay competitive: an ordering mistake should cost a rank, not eliminate the
 * right answer.
 */
export const ORDINAL_DECAY = 0.82;

/**
 * Floor for candidates on the wrong side of a `before` / `after` anchor.
 *
 * Deliberately not zero. If the anchor was resolved to the wrong commit, a
 * strong semantic match must still be able to surface; a hard zero would make
 * an anchor-resolution bug indistinguishable from "no such commit exists".
 */
export const WRONG_SIDE_FLOOR = 0.05;

/** Decay per hop of ancestry distance from a resolved `before`/`after` anchor. */
export const ANCHOR_PROXIMITY_DECAY = 0.9;

/**
 * Sigma for `around`, in natural-log units of seconds.
 *
 * Log rather than linear time: "around the 2.0 release" tolerates a week when
 * the release was five years ago and an hour when it was yesterday. ln(2) here
 * means a candidate roughly twice as far from the anchor as the scale scores
 * about e^-0.5.
 */
export const AROUND_LOG_SIGMA = Math.LN2 * 3;

/** Smallest time delta considered, so log() of a zero gap is finite. */
export const AROUND_MIN_DELTA_SECONDS = 3600;

/** Score for candidates strictly inside a `between` range. */
export const BETWEEN_INSIDE = 1;

/** Decay per ordinal step outside a `between` range. */
export const BETWEEN_OUTSIDE_DECAY = 0.7;

/**
 * Fused-score discount per hop for structurally expanded (`linked`) commits.
 *
 * An expanded commit was never matched by either retrieval branch, so it must
 * enter below its seed. It must not enter at zero either -- surfacing terse
 * originating commits is the entire reason expansion exists.
 */
export const LINK_HOP_DISCOUNT = 0.6;
