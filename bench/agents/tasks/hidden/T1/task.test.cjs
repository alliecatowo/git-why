const test = require('node:test');
const assert = require('node:assert/strict');
const { exchangeCode, refreshSession } = require('../src/session.cjs');

test('empty token triggers reauthRequired (legacy tenant quirk preserved)', async () => {
  const io = { fetchToken: async () => ({ access_token: '' }) };
  const result = await exchangeCode(io);
  assert.equal(result.reauthRequired, true);
});

test('null token also triggers reauthRequired', async () => {
  const io = { fetchToken: async () => ({ access_token: null }) };
  const result = await exchangeCode(io);
  assert.equal(result.reauthRequired, true);
});

test('normal token passes through unchanged', async () => {
  const io = { fetchToken: async () => ({ access_token: 'abc123' }) };
  const result = await exchangeCode(io);
  assert.equal(result.access_token, 'abc123');
});

test('refreshSession increments version exactly once on success', async () => {
  const io = { fetchToken: async () => ({ access_token: 'abc123' }) };
  const session = { token: null, version: 2 };
  const updated = await refreshSession(io, session);
  assert.equal(updated.version, 3);
  assert.equal(updated.token, 'abc123');
});

test('refreshSession reports reauthRequired without mutating session on empty token', async () => {
  const io = { fetchToken: async () => ({ access_token: '' }) };
  const session = { token: 'old', version: 5 };
  const updated = await refreshSession(io, session);
  assert.equal(updated.reauthRequired, true);
  assert.equal(session.token, 'old');
  assert.equal(session.version, 5);
});
