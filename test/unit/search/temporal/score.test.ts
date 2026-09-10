import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyTemporal,
  exponentFor,
  temporalScore,
  type TemporalCandidate,
  type TemporalContext,
} from '../../../../src/search/temporal/score.js';
import { NO_TEMPORAL_CONSTRAINT, type TemporalConstraint } from '../../../../src/types.js';

const ALL_TYPES = [
  'none',
  'first',
  'last',
  'removed',
  'changed_when',
  'before',
  'after',
  'between',
  'around',
  'timeline',
] as const;

function constraint(
  type: TemporalConstraint['type'],
  confidence: TemporalConstraint['confidence'] = 'explicit',
): TemporalConstraint {
  return { type, confidence, anchor: null, anchorEnd: null };
}

function candidate(over: Partial<TemporalCandidate> = {}): TemporalCandidate {
  return { sha: 'a'.repeat(40), ordinal: 0, committerTime: 1_700_000_000, ...over };
}

const ctx: TemporalContext = { candidateCount: 10 };

test('the identity constraint scores exactly 1 for every candidate', () => {
  // Not "approximately 1". The whole non-regression argument rests on this.
  for (let ordinal = 0; ordinal < 20; ordinal += 1) {
    const score = temporalScore(candidate({ ordinal }), NO_TEMPORAL_CONSTRAINT, ctx);
    assert.equal(score, 1, `ordinal ${ordinal}`);
  }
});

test('the identity constraint has exponent exactly 0', () => {
  assert.equal(exponentFor(NO_TEMPORAL_CONSTRAINT), 0);
});

test('applyTemporal with w=0 returns the fused score bit-identically', () => {
  // Bit-identical, not close. This is what makes "ranking is unchanged for
  // non-temporal queries" a guarantee rather than an expectation.
  for (const fused of [0, 0.0325, 0.016393442622950817, 1 / 3, Math.PI, 1e-12]) {
    assert.equal(applyTemporal(fused, 1, 0), fused, `fused=${fused}`);
    // Even a temporal score that is not 1 must be ignored when w is 0.
    assert.equal(applyTemporal(fused, 0.017, 0), fused, `fused=${fused} with hostile temporal`);
  }
});

test('confidence sets the exponent, and never gates the term', () => {
  assert.equal(exponentFor(constraint('first', 'explicit')), 1);
  assert.equal(exponentFor(constraint('first', 'inferred')), 0.5);
});

test('every constraint type produces a score inside [0, 1]', () => {
  for (const type of ALL_TYPES) {
    for (let ordinal = 0; ordinal < 12; ordinal += 1) {
      for (const relation of ['ancestor', 'descendant', 'unrelated', 'self', undefined] as const) {
        const score = temporalScore(
          candidate({ ordinal, relationToAnchor: relation, distanceToAnchor: ordinal }),
          constraint(type),
          { candidateCount: 12, anchorTime: 1_700_000_000, anchorEndTime: 1_700_500_000 },
        );
        assert.ok(
          score >= 0 && score <= 1 && Number.isFinite(score),
          `${type} ordinal=${ordinal} relation=${relation} -> ${score}`,
        );
      }
    }
  }
});

test('first is monotonically non-increasing in ancestry ordinal', () => {
  let previous = Infinity;
  for (let ordinal = 0; ordinal < 15; ordinal += 1) {
    const score = temporalScore(candidate({ ordinal }), constraint('first'), ctx);
    assert.ok(score <= previous, `ordinal ${ordinal}: ${score} > ${previous}`);
    previous = score;
  }
  assert.equal(temporalScore(candidate({ ordinal: 0 }), constraint('first'), ctx), 1);
});

test('last is the mirror of first', () => {
  const count = 10;
  const c: TemporalContext = { candidateCount: count };
  const latest = temporalScore(candidate({ ordinal: count - 1 }), constraint('last'), c);
  const earliest = temporalScore(candidate({ ordinal: 0 }), constraint('last'), c);
  assert.equal(latest, 1);
  assert.ok(earliest < latest);

  let previous = -Infinity;
  for (let ordinal = 0; ordinal < count; ordinal += 1) {
    const score = temporalScore(candidate({ ordinal }), constraint('last'), c);
    assert.ok(score >= previous, `last must be non-decreasing in ordinal at ${ordinal}`);
    previous = score;
  }
});

test('removed shares the first-shape over the removal chain', () => {
  const first = temporalScore(candidate({ ordinal: 0 }), constraint('removed'), ctx);
  const later = temporalScore(candidate({ ordinal: 4 }), constraint('removed'), ctx);
  assert.equal(first, 1);
  assert.ok(later < first);
});

test('before favours ancestors and after favours descendants, by proximity', () => {
  const near = candidate({ relationToAnchor: 'ancestor', distanceToAnchor: 1 });
  const far = candidate({ relationToAnchor: 'ancestor', distanceToAnchor: 8 });
  const wrongSide = candidate({ relationToAnchor: 'descendant', distanceToAnchor: 1 });

  const nearScore = temporalScore(near, constraint('before'), ctx);
  const farScore = temporalScore(far, constraint('before'), ctx);
  assert.ok(nearScore > farScore, 'closer ancestors must score higher');
  assert.ok(farScore > temporalScore(wrongSide, constraint('before'), ctx));

  // Mirrored for `after`.
  const afterNear = candidate({ relationToAnchor: 'descendant', distanceToAnchor: 1 });
  assert.ok(
    temporalScore(afterNear, constraint('after'), ctx) >
      temporalScore(near, constraint('after'), ctx),
  );
});

test('the wrong side of an anchor is penalised but never zeroed', () => {
  // A hard zero would make a mis-resolved anchor indistinguishable from "no
  // such commit", and would let one bad anchor erase the whole result set.
  const score = temporalScore(
    candidate({ relationToAnchor: 'descendant', distanceToAnchor: 3 }),
    constraint('before'),
    ctx,
  );
  assert.ok(score > 0, 'wrong-side candidates must stay recoverable by relevance');
  assert.ok(score < 0.5);
});

test('an unevaluable constraint falls back to identity rather than inventing an order', () => {
  // No ancestry information available: the honest answer is pure relevance.
  assert.equal(
    temporalScore(candidate({ relationToAnchor: undefined }), constraint('before'), ctx),
    1,
  );
  assert.equal(temporalScore(candidate(), constraint('around'), { candidateCount: 5 }), 1);
  assert.equal(temporalScore(candidate(), constraint('between'), { candidateCount: 5 }), 1);
});

test('around peaks at the anchor and decays symmetrically in log time', () => {
  const anchorTime = 1_700_000_000;
  const c: TemporalContext = { candidateCount: 5, anchorTime };
  const at = temporalScore(candidate({ committerTime: anchorTime }), constraint('around'), c);
  const week = temporalScore(
    candidate({ committerTime: anchorTime + 604800 }),
    constraint('around'),
    c,
  );
  const year = temporalScore(
    candidate({ committerTime: anchorTime + 31556952 }),
    constraint('around'),
    c,
  );
  assert.equal(at, 1);
  assert.ok(week < at && year < week, `expected 1 > ${week} > ${year}`);

  // Symmetric: equal distance either side scores the same.
  const behind = temporalScore(
    candidate({ committerTime: anchorTime - 604800 }),
    constraint('around'),
    c,
  );
  assert.ok(Math.abs(behind - week) < 1e-12);
});

test('between scores inside the range at 1 and decays outside it', () => {
  const c: TemporalContext = {
    candidateCount: 5,
    anchorTime: 1_700_000_000,
    anchorEndTime: 1_700_500_000,
  };
  assert.equal(
    temporalScore(candidate({ committerTime: 1_700_250_000 }), constraint('between'), c),
    1,
  );
  const justOutside = temporalScore(
    candidate({ committerTime: 1_700_600_000 }),
    constraint('between'),
    c,
  );
  const farOutside = temporalScore(
    candidate({ committerTime: 1_800_000_000 }),
    constraint('between'),
    c,
  );
  assert.ok(justOutside < 1);
  assert.ok(farOutside < justOutside);
});

test('timeline and changed_when leave the ranking to relevance', () => {
  // Coverage, not ordering, is the goal for these; the payload rides in the
  // `timeline` and `answer` fields instead.
  for (const type of ['timeline', 'changed_when'] as const) {
    assert.equal(temporalScore(candidate({ ordinal: 7 }), constraint(type), ctx), 1);
  }
});

test('the temporal term can lower a rank but cannot erase a strong match', () => {
  const strongButLate = applyTemporal(0.032, 0.05, 1);
  const weakButEarly = applyTemporal(0.001, 1, 1);
  assert.ok(strongButLate > weakButEarly, 'semantic relevance must stay in the product');
});
