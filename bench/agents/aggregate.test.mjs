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

// A network attempt is a command, not a word. `NETWORK_RE` used to be
// `\bcurl\b` matched against every string of every tool call, and one of the
// benchmark repositories is curl — so listing its directory, or an agent
// writing "the curl repository", invalidated the trial. It cost 11 of 51 curl
// trials against 1 of 139 everywhere else: a whole repository's worth of data,
// lost to a substring.
import { auditTrajectory } from './audit.mjs';

const audit = (calls) =>
  auditTrajectory({
    rawEvents: [{ type: 'x' }],
    toolCalls: [
      // The preflight the audit requires as the first bash call.
      {
        tool: 'bash',
        input: { command: 'pwd && git rev-parse --show-toplevel && git rev-parse HEAD' },
      },
      ...calls,
    ],
    workspaceDir: '/workspace',
    executionWorkspaceDir: '/workspace',
    baseSha: 'a'.repeat(40),
  }).violations;

test('working in a repository named curl is not a network attempt', () => {
  const violations = audit([
    { tool: 'read', input: { filePath: '/workspace/curl-curl/README' } },
    { tool: 'bash', input: { command: 'git log --grep=curl --oneline -20' } },
    { tool: 'bash', input: { command: 'grep -rn curl lib/' } },
    { tool: 'bash', input: { command: 'git why "why does curl retry on reset" --no-refresh' } },
  ]);
  assert.ok(
    !violations.includes('network_fetch_attempt'),
    `expected no network violation, got ${JSON.stringify(violations)}`,
  );
});

test('an actual fetch is still caught, in every command position', () => {
  for (const command of [
    'curl https://example.com',
    'sudo curl -O http://example.com/x',
    'ls -la && curl http://example.com',
    'wget http://example.com',
    'git clone https://github.com/foo/bar',
    'npm install left-pad',
    'pip install requests',
  ]) {
    const violations = audit([{ tool: 'bash', input: { command } }]);
    assert.ok(
      violations.includes('network_fetch_attempt'),
      `expected ${JSON.stringify(command)} to be flagged, got ${JSON.stringify(violations)}`,
    );
  }
});

test('a non-shell tool cannot fetch, so its contents are not scanned for commands', () => {
  // A file whose CONTENTS are a curl command is being read, not run.
  const violations = audit([
    { tool: 'read', input: { filePath: '/workspace/scripts/fetch.sh' } },
    { tool: 'grep', input: { pattern: 'curl https://' } },
  ]);
  assert.ok(!violations.includes('network_fetch_attempt'), JSON.stringify(violations));
});

// Brief scoring. A brief is six questions in one session, scored 0..6 — the
// whole reason these tasks replaced single-question lookups is that one bit
// per expensive agent session is close to no signal at single-digit n.
import { gradeBrief } from './grade.mjs';

const GOLD = [
  'f55548ba9f24dda192880d4a3da2b52e90f6e194',
  '3af0e76d1e71995b7790c74e79b76af86ee7c681',
  'aaaaaaaabbbbbbbbccccccccddddddddeeeeeeee',
];

test('one point per gold commit cited, with per-question detail', () => {
  const grade = gradeBrief({
    goldShas: GOLD,
    finalAnswer: '1. see f55548ba\n2. no supporting commit found\n3. see aaaaaaaabbbb',
    finalPatch: '',
  });
  assert.equal(grade.score, 2);
  assert.equal(grade.outOf, 3);
  assert.deepEqual(grade.found, [true, false, true]);
});

// An agent that answers out of order, or numbers its answers differently, has
// still found the commit. Penalising that would measure presentation rather
// than retrieval, which is not what the arms differ on.
test('order does not matter; finding the commit does', () => {
  const grade = gradeBrief({
    goldShas: GOLD,
    finalAnswer: 'Question 3: aaaaaaaabbbbbbbb. Question 1: f55548ba9f24.',
    finalPatch: '',
  });
  assert.equal(grade.score, 2);
});

test('abbreviations count in both directions, down to seven characters', () => {
  // Agents quote short SHAs; the gold is full-length.
  assert.equal(gradeBrief({ goldShas: GOLD, finalAnswer: 'f55548b', finalPatch: '' }).score, 1);
  // And a full-length citation against an abbreviated gold.
  assert.equal(
    gradeBrief({ goldShas: ['f55548ba'], finalAnswer: GOLD[0], finalPatch: '' }).score,
    1,
  );
  // Six characters is not enough to be a citation rather than a coincidence.
  assert.equal(gradeBrief({ goldShas: GOLD, finalAnswer: 'f55548', finalPatch: '' }).score, 0);
});

test('a brief that answers nothing scores zero rather than failing to grade', () => {
  const grade = gradeBrief({
    goldShas: GOLD,
    finalAnswer: 'I could not find supporting commits for any of these.',
    finalPatch: '',
  });
  assert.equal(grade.score, 0);
  assert.equal(grade.citedGoldSha, false);
  assert.deepEqual(grade.found, [false, false, false]);
});

test('a task with no gold commits is ungradeable, not a zero', () => {
  // Scoring an ungradeable task as zero is how a harness fault becomes a
  // finding about the product.
  assert.equal(gradeBrief({ goldShas: [], finalAnswer: 'x', finalPatch: '' }), null);
  assert.equal(gradeBrief({ goldShas: null, finalAnswer: 'x', finalPatch: '' }), null);
});

test('a citation in the patch counts, not just in the prose', () => {
  const grade = gradeBrief({
    goldShas: GOLD,
    finalAnswer: 'see the comment I added',
    finalPatch: '+// introduced in f55548ba9f24dda1',
  });
  assert.equal(grade.score, 1);
});
