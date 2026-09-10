/**
 * Constraint-shaped temporal scoring.
 *
 * `final = fused * temporal ** w`, with `temporal` in [0, 1].
 *
 * The shape follows MRAG's per-constraint splines, but computed over DAG
 * position rather than over dates. Rebases and cherry-picks rewrite committer
 * and author time freely, and they do it on exactly the repositories where
 * "when was this first introduced" is worth asking, so an ordinal decided by
 * timestamp is decided by something the repository does not actually promise.
 *
 * Semantic relevance is never discarded: the fused RRF score stays a factor in
 * the product, so a commit the temporal term dislikes can still win on
 * relevance. That is deliberate -- intent detection is rule-based and will be
 * wrong sometimes, and the failure mode of a multiplicative penalty is a worse
 * rank, not a lost result.
 */

import type { TemporalConstraint } from '../../types.js';
import {
  ANCHOR_PROXIMITY_DECAY,
  AROUND_LOG_SIGMA,
  AROUND_MIN_DELTA_SECONDS,
  BETWEEN_INSIDE,
  BETWEEN_OUTSIDE_DECAY,
  EXPONENT,
  ORDINAL_DECAY,
  WRONG_SIDE_FLOOR,
} from './tuning.js';

/**
 * A candidate as the temporal layer sees it. Everything here is a position in
 * the commit graph, except `committerTime`, which is used only by `around`
 * (where the user asked about wall-clock proximity, so wall clock is the
 * right answer even though it can lie).
 */
export interface TemporalCandidate {
  readonly sha: string;
  /** Rank in ancestry order among the candidate set; 0 is earliest. */
  readonly ordinal: number;
  readonly committerTime: number;
  readonly relationToAnchor?: 'ancestor' | 'descendant' | 'unrelated' | 'self';
  /** Hops along ancestry to the anchor, when computable. */
  readonly distanceToAnchor?: number;
}

export interface TemporalContext {
  /** Number of candidates being scored; used to mirror ordinals for `last`. */
  readonly candidateCount: number;
  /** Committer time of the resolved anchor, for `around` and `between`. */
  readonly anchorTime?: number | null;
  readonly anchorEndTime?: number | null;
}

/** The exponent `w` for a constraint. Exactly 0 for `none`. */
export function exponentFor(c: TemporalConstraint): number {
  if (c.type === 'none') return EXPONENT.none;
  return c.confidence === 'explicit' ? EXPONENT.explicit : EXPONENT.inferred;
}

/** Geometric decay, clamped into [0, 1]. */
function decay(base: number, steps: number): number {
  if (steps <= 0) return 1;
  return Math.max(0, Math.min(1, base ** steps));
}

/**
 * Gaussian in log time.
 *
 * Log rather than linear because temporal tolerance scales with distance:
 * "around the 2.0 release" means within a week if that was five years ago and
 * within an hour if it was this morning. A linear Gaussian needs a different
 * sigma for every repository age; a log one does not.
 */
function aroundScore(candidateTime: number, anchorTime: number): number {
  const delta = Math.max(AROUND_MIN_DELTA_SECONDS, Math.abs(candidateTime - anchorTime));
  const z = Math.log(delta / AROUND_MIN_DELTA_SECONDS) / AROUND_LOG_SIGMA;
  return Math.exp(-0.5 * z * z);
}

/**
 * Scores one candidate against one constraint. Always in [0, 1].
 *
 * `none` returns exactly 1 -- not approximately, not 0.999. Combined with an
 * exponent of 0 this makes the whole temporal stage a provable no-op for
 * ordinary queries, which is the property the non-regression test asserts.
 */
export function temporalScore(
  candidate: TemporalCandidate,
  c: TemporalConstraint,
  ctx: TemporalContext,
): number {
  switch (c.type) {
    case 'none':
      return 1;

    // Coverage, not ordering, is the goal for these two: the ranked list
    // should stay in relevance order and the timeline/answer fields carry the
    // temporal payload. Returning identity keeps the fused score intact.
    case 'timeline':
    case 'changed_when':
      return 1;

    case 'first':
    case 'removed':
      // `removed` shares the shape; the caller supplies ordinals drawn from
      // the removal chain rather than the addition chain.
      return decay(ORDINAL_DECAY, candidate.ordinal);

    case 'last': {
      const mirrored = Math.max(0, ctx.candidateCount - 1 - candidate.ordinal);
      return decay(ORDINAL_DECAY, mirrored);
    }

    case 'before':
    case 'after': {
      const wanted = c.type === 'before' ? 'ancestor' : 'descendant';
      const relation = candidate.relationToAnchor;

      // No ancestry information (an unresolved or dateless anchor) means the
      // constraint cannot be evaluated. Identity is the honest answer: fall
      // back to pure relevance rather than invent an ordering.
      if (relation === undefined) return 1;
      if (relation === 'self') return 1;

      if (relation === wanted) {
        return decay(ANCHOR_PROXIMITY_DECAY, candidate.distanceToAnchor ?? 0);
      }

      // Wrong side, or on a parallel branch. Floored rather than zeroed so a
      // mis-resolved anchor degrades the ranking instead of erasing the
      // result set.
      return WRONG_SIDE_FLOOR;
    }

    case 'between': {
      const start = ctx.anchorTime;
      const end = ctx.anchorEndTime;
      if (start === null || start === undefined || end === null || end === undefined) return 1;
      const lo = Math.min(start, end);
      const hi = Math.max(start, end);
      if (candidate.committerTime >= lo && candidate.committerTime <= hi) return BETWEEN_INSIDE;

      // Outside: decay by how far out, measured in ordinal steps so the shape
      // matches the other constraints rather than in raw seconds.
      const outsideBy =
        candidate.committerTime < lo ? lo - candidate.committerTime : candidate.committerTime - hi;
      const steps = Math.log1p(outsideBy / AROUND_MIN_DELTA_SECONDS);
      return decay(BETWEEN_OUTSIDE_DECAY, steps);
    }

    case 'around': {
      const anchorTime = ctx.anchorTime;
      if (anchorTime === null || anchorTime === undefined) return 1;
      return aroundScore(candidate.committerTime, anchorTime);
    }
  }
}

/**
 * Combines the two scores.
 *
 * With `w === 0` this returns `fused` by an exact short-circuit rather than by
 * computing `fused * temporal ** 0`. Floating-point exponentiation of 1 is not
 * guaranteed to be bit-identical across engines, and the non-regression
 * guarantee is stated as bit-identical ranking, so the guarantee is enforced
 * in code instead of hoped for.
 */
export function applyTemporal(fused: number, temporal: number, w: number): number {
  if (w === 0) return fused;
  return fused * temporal ** w;
}
