import test from 'node:test';
import assert from 'node:assert/strict';

import { aggregateAgentRecords, selectLogicalTrials } from './aggregate.mjs';

function record(overrides = {}) {
  return {
    completed: true,
    task_id: 'T1',
    task_stratum: 'coding',
    arm: 'A',
    repetition: 1,
    attempt: 1,
    key: 'T1-A-1',
    exit_reason: 'completed',
    invalidation_reason: null,
    treatment_error: null,
    pass: true,
    wall_ms: 10,
    input_tokens: 20,
    output_tokens: 3,
    git_why_calls: 0,
    zg_calls: 0,
    ...overrides,
  };
}

test('rubric pass:null is valid but never included in a pass denominator', () => {
  const summary = aggregateAgentRecords([
    record(),
    record({ task_id: 'T2', task_stratum: 'rubric', arm: 'A', key: 'T2-A-1', pass: null }),
  ]);
  assert.deepEqual(summary.byStratumArm.coding.A, {
    attempted: 1,
    valid: 1,
    numerator: 1,
    denominator: 1,
    rate: 1,
    unscoredValid: 0,
  });
  assert.equal(summary.byStratumArm.rubric.A.denominator, 0);
  assert.equal(summary.byStratumArm.rubric.A.unscoredValid, 1);
});

test('outcomes use the retry while all-attempt resources retain both attempts', () => {
  const first = record({ exit_reason: 'infrastructure_error', pass: false, wall_ms: 9 });
  const retry = record({ attempt: 2, pass: true, wall_ms: 11 });
  const summary = aggregateAgentRecords([first, retry]);
  assert.equal(selectLogicalTrials([first, retry]).length, 1);
  assert.equal(summary.byArm.A.denominator, 1);
  assert.equal(summary.byArm.A.numerator, 1);
  assert.equal(summary.resources.allAttempts.wall_ms.total, 20);
  assert.equal(summary.resources.successfulOnly.wall_ms.total, 11);
});

test('invalidated records are listed and excluded from outcome rates', () => {
  const summary = aggregateAgentRecords([
    record({ invalidation_reason: 'read evaluator material', pass: true, wall_ms: 40 }),
  ]);
  assert.equal(summary.valid, 0);
  assert.equal(summary.byArm.A.denominator, 0);
  assert.deepEqual(
    summary.invalidated.map((entry) => entry.reason),
    ['read evaluator material'],
  );
  assert.equal(summary.resources.allAttempts.n, 1);
  assert.equal(summary.resources.successfulOnly.n, 0);
});

test('bootstrap CI clusters repetitions by task and is deterministic', () => {
  const records = [
    record({ task_id: 'T1', arm: 'A', key: 'a1', pass: false }),
    record({ task_id: 'T1', arm: 'B', key: 'b1', pass: true }),
    record({ task_id: 'T1', arm: 'A', repetition: 2, key: 'a2', pass: false }),
    record({ task_id: 'T1', arm: 'B', repetition: 2, key: 'b2', pass: true }),
    record({ task_id: 'T2', arm: 'A', key: 'a3', pass: true }),
    record({ task_id: 'T2', arm: 'B', key: 'b3', pass: false }),
  ];
  const one = aggregateAgentRecords(records).bootstrapCiByArm.B;
  const two = aggregateAgentRecords(records).bootstrapCiByArm.B;
  assert.equal(one.clusters, 2);
  assert.equal(one.estimate, 0);
  assert.deepEqual(one, two);
});
