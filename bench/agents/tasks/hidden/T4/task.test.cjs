const test = require('node:test');
const assert = require('node:assert/strict');
const { callProvider } = require('../src/gateway.cjs');

test('a network error on the non-idempotent /charge endpoint is never retried', async () => {
  let calls = 0;
  const io = {
    send: async (req) => {
      calls++;
      throw new Error('network_error');
    },
  };
  await assert.rejects(() => callProvider(io, { path: '/charge', amount: 100 }));
  assert.equal(calls, 1, `expected exactly 1 call to /charge, got ${calls}`);
});

test('a network error on an idempotent endpoint is retried and can succeed', async () => {
  let calls = 0;
  const io = {
    send: async (req) => {
      calls++;
      if (calls < 2) throw new Error('network_error');
      return { ok: true };
    },
  };
  const result = await callProvider(io, { path: '/status' });
  assert.equal(result.ok, true);
  assert.ok(calls >= 2 && calls <= 3, `expected 2-3 calls to /status, got ${calls}`);
});

test('retries on an idempotent endpoint give up after the retry budget', async () => {
  let calls = 0;
  const io = {
    send: async () => {
      calls++;
      throw new Error('network_error');
    },
  };
  await assert.rejects(() => callProvider(io, { path: '/status' }));
  assert.ok(calls <= 3, `expected at most 3 calls (1 original + 2 retries), got ${calls}`);
});
