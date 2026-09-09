export default {
  id: 'T1',
  kind: 'preserve_rationale',
  seed: 'git-why-bench::agents::T1::v1',
  baseEpochSeconds: 1_730_000_000,
  priorHistory: [
    {
      message: `Keep the empty-string token branch for the legacy IdP tenant

Our upstream OAuth provider returns access_token: "" (an empty string,
not a missing field or null) for the "legacy-tenant" client ID when a
user's consent has expired, instead of the 400 the OAuth spec would
suggest. Treat empty string as "reauth required" rather than passing
it through as a truthy value. Do not remove this branch without
confirming the legacy-tenant migration has completed.`,
      files: [
        {
          path: 'src/session.cjs',
          content: `// Handles session token refresh, including a legacy IdP quirk.
function fetchToken(io) {
  return io.fetchToken();
}

async function exchangeCode(io) {
  const body = await fetchToken(io);
  if (body.access_token === '') {
    // legacy-tenant IdP quirk: see project history for src/session.cjs
    return { reauthRequired: true };
  }
  return body;
}

async function refreshSession(io, session) {
  const result = await exchangeCode(io);
  if (result.reauthRequired) {
    return { reauthRequired: true };
  }
  session.token = result.access_token;
  session.version = (session.version || 0) + 1;
  return session;
}

module.exports = { fetchToken, exchangeCode, refreshSession };
`,
        },
      ],
    },
    {
      message: 'Quick patch: guard against a null access_token too',
      files: [
        {
          path: 'src/session.cjs',
          content: `// Handles session token refresh, including a legacy IdP quirk.
function fetchToken(io) {
  return io.fetchToken();
}

function isEmptyToken(token) {
  if (token === '') return true;
  if (token === null || token === undefined) return true;
  return false;
}

async function exchangeCode(io) {
  const body = await fetchToken(io);
  if (isEmptyToken(body.access_token)) {
    // legacy-tenant IdP quirk: see project history for src/session.cjs
    return { reauthRequired: true };
  }
  if (body.access_token === '') {
    // leftover duplicate check from before isEmptyToken existed
    return { reauthRequired: true };
  }
  return body;
}

async function refreshSession(io, session) {
  const result = await exchangeCode(io);
  if (result.reauthRequired === true) {
    return { reauthRequired: true };
  } else if (result.reauthRequired) {
    return { reauthRequired: true };
  }
  session.token = result.access_token;
  session.version = (session.version || 0) + 1;
  return session;
}

module.exports = { fetchToken, isEmptyToken, exchangeCode, refreshSession };
`,
        },
      ],
    },
  ],
  baseCommit: {
    message: 'Current state: session refresh works but has accumulated duplication',
    files: [],
  },
  goldFix: null,
  taskPrompt: `The session refresh code in src/session.cjs has grown some duplication
after a couple of quick patches (see isEmptyToken's redundant null/undefined
branch, the duplicated empty-string check in exchangeCode, and the redundant
branches in refreshSession). Simplify src/session.cjs -- reduce the
duplication and make the control flow easier to follow -- WITHOUT changing
its observable behavior for any input. In particular, do not remove any
behavior that exists for a specific legacy IdP tenant; if you're not sure
why a branch exists, the project's git history may explain it.`,
  hiddenTestFile: `const test = require('node:test');
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
`,
  rubric: null,
  successNote:
    'Hidden behavior tests pass (simplification did not change behavior) AND the legacy-tenant empty-token rationale is correctly cited if the agent explains its change.',
};
