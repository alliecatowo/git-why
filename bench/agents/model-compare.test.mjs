import test from 'node:test';
import assert from 'node:assert/strict';

import { preferTrial } from './model-compare.mjs';

// One model can be run more than once: deepseek-v4-flash has an original run
// and a re-run added after token reconciliation existed. That produces two
// trials for the same (task, arm), and before this rule whichever the
// filesystem listed last won — so the paired comparison depended on readdir
// order, which is exactly the kind of arbitrary input this project keeps
// finding behind plausible numbers.

const trial = (overrides) => ({
  task_id: 'X-curl-01',
  arm: 'A',
  token_cross_check_agrees: null,
  __runId: 'pilot-2026-09-10T00-00-00-000Z',
  ...overrides,
});

test('a trial with reconciled tokens beats one without, regardless of age', () => {
  const older = trial({ token_cross_check_agrees: true, __runId: 'pilot-2026-09-01' });
  const newer = trial({ token_cross_check_agrees: null, __runId: 'pilot-2026-09-30' });
  assert.equal(preferTrial(older, newer), older);
  assert.equal(preferTrial(newer, older), older);
});

test('a trial whose tokens disagree loses to one that was never checked', () => {
  const unchecked = trial({ token_cross_check_agrees: null });
  const disagreed = trial({ token_cross_check_agrees: false, __runId: 'pilot-2026-09-30' });
  assert.equal(preferTrial(unchecked, disagreed), unchecked);
  assert.equal(preferTrial(disagreed, unchecked), unchecked);
});

test('at equal evidence quality the later run wins, since it ran against newer code', () => {
  const older = trial({ token_cross_check_agrees: true, __runId: 'pilot-2026-09-01' });
  const newer = trial({ token_cross_check_agrees: true, __runId: 'pilot-2026-09-30' });
  assert.equal(preferTrial(older, newer), newer);
  assert.equal(preferTrial(newer, older), newer);
});

test('the choice does not depend on argument order', () => {
  const cases = [
    [trial({ token_cross_check_agrees: true }), trial({ token_cross_check_agrees: false })],
    [trial({ __runId: 'a' }), trial({ __runId: 'b' })],
    [trial({ token_cross_check_agrees: false }), trial({ token_cross_check_agrees: null })],
  ];
  for (const [a, b] of cases) {
    assert.equal(preferTrial(a, b), preferTrial(b, a));
  }
});

// The median returned `v[Math.floor(v.length / 2)]`, which is right for odd
// counts and biased upward for even ones. Paired comparisons run at n=6 to
// n=9, so even is common — and on a signed, bimodal delta the bias changed a
// conclusion: per-task call deltas of -114, -16, -13, +8, +11, +14 have a true
// median of -2.5 and were reported as +8.
import { median } from './model-compare.mjs';

test('an even-length median averages the two middle values', () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([-114, -16, -13, 8, 11, 14]), -2.5);
});

test('an odd-length median is the middle value', () => {
  assert.equal(median([1, 2, 3]), 2);
  assert.equal(median([5]), 5);
});

test('the median does not depend on input order', () => {
  assert.equal(median([14, -13, 8, -114, 11, -16]), median([-114, -16, -13, 8, 11, 14]));
});

test('non-numeric entries are excluded rather than coerced', () => {
  // A null tool_calls must not become a zero and drag the median toward it.
  assert.equal(median([1, null, 3, undefined, NaN]), 2);
  assert.equal(median([]), null);
  assert.equal(median([null, undefined]), null);
});
