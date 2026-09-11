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
