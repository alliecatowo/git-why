export default {
  id: 'T4',
  kind: 'architecture_constraint',
  seed: 'git-why-bench::agents::T4::v1',
  baseEpochSeconds: 1_733_000_000,
  priorHistory: [
    {
      message: `Never retry Initech's /charge endpoint

Initech's /charge endpoint is not idempotent: retrying a charge
request that actually reached their server (but whose response we
missed due to a network error) creates a second real-world charge.
Their API docs (section 12) confirm there is no idempotency-key
mechanism on this endpoint. Every other Initech endpoint is safe to
retry on network error.`,
      files: [
        {
          path: 'src/gateway.cjs',
          content: `// Talks to the Initech provider. No retry behavior yet.
async function callProvider(io, req) {
  return io.send(req);
}

module.exports = { callProvider };
`,
        },
      ],
    },
  ],
  baseCommit: {
    message: 'Current state before adding general retry support',
    files: [],
  },
  goldFix: null,
  taskPrompt: `Add retry-on-network-error behavior to callProvider in src/gateway.cjs:
on a network error (io.send rejects with an Error whose message is
"network_error"), retry the request up to 2 additional times before giving
up. Some Initech endpoints must NEVER be retried automatically because a
retry can cause a duplicate real-world effect -- check the project history
or comments for which ones and why, and make sure your retry logic respects
that constraint.`,
  hiddenTestFile: `const test = require('node:test');
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
  assert.equal(calls, 1, \`expected exactly 1 call to /charge, got \${calls}\`);
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
  assert.ok(calls >= 2 && calls <= 3, \`expected 2-3 calls to /status, got \${calls}\`);
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
  assert.ok(calls <= 3, \`expected at most 3 calls (1 original + 2 retries), got \${calls}\`);
});
`,
  rubric: null,
  successNote:
    'Correct retry behavior for idempotent endpoints and no double-effect risk on /charge.',
};
