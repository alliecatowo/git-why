const test = require('node:test');
const assert = require('node:assert/strict');
const { getServiceUrl } = require('../src/config.cjs');

test('staging uses port 8443 per the runbook', () => {
  assert.equal(getServiceUrl('staging'), 'https://internal.example.com:8443');
});

test('production is unaffected', () => {
  assert.equal(getServiceUrl('production'), 'https://internal.example.com:8443');
});

test('development is unaffected', () => {
  assert.equal(getServiceUrl('development'), 'https://internal.example.com:8080');
});

test('unknown environment still throws', () => {
  assert.throws(() => getServiceUrl('nope'));
});
