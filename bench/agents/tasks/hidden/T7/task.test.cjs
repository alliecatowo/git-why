const test = require('node:test');
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
