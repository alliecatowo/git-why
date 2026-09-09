export default {
  id: 'T7',
  kind: 'simple_edit_control',
  seed: 'git-why-bench::agents::T7::v1',
  baseEpochSeconds: 1_737_000_000,
  priorHistory: [],
  baseCommit: {
    message: 'Add src/utils.cjs',
    files: [
      {
        path: 'src/utils.cjs',
        content: `// Small shared utilities.
module.exports = {};
`,
      },
    ],
  },
  goldFix: null,
  taskPrompt: `Implement a function \`clampRetryDelay(ms)\` in src/utils.cjs and export it:
it should return \`ms\` clamped to the inclusive range [100, 5000]. Values
below 100 become 100; values above 5000 become 5000; values in between are
returned unchanged. This is fully specified -- no need to look at project
history.`,
  hiddenTestFile: `const test = require('node:test');
const assert = require('node:assert/strict');
const { clampRetryDelay } = require('../src/utils.cjs');

test('clamps below the floor', () => {
  assert.equal(clampRetryDelay(0), 100);
  assert.equal(clampRetryDelay(-50), 100);
});

test('clamps above the ceiling', () => {
  assert.equal(clampRetryDelay(10_000), 5000);
});

test('passes through in-range values unchanged', () => {
  assert.equal(clampRetryDelay(100), 100);
  assert.equal(clampRetryDelay(5000), 5000);
  assert.equal(clampRetryDelay(2500), 2500);
});
`,
  rubric: null,
  successNote: 'Fully specified localized behavior; history is unnecessary and should not be needed to pass.',
};
