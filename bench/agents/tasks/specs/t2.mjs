export default {
  id: 'T2',
  kind: 'recurrent_regression',
  seed: 'git-why-bench::agents::T2::v1',
  baseEpochSeconds: 1_731_000_000,
  priorHistory: [
    {
      message: `Fix duplicate message dispatch after reconnect

When a client reconnects mid-session, addSocket() re-added the socket
to the room without checking it was already present, so dispatch()
sent every message twice for the remainder of the session. Guard
addSocket() with a has() check so resubscription is idempotent.`,
      files: [
        {
          path: 'src/relay.cjs',
          content: `// Fans a message out to every socket registered for a room.
function createPool() {
  return { sockets: new Set() };
}

function addSocket(pool, socket) {
  if (pool.sockets.has(socket)) return; // reconnect can re-add the same socket
  pool.sockets.add(socket);
}

function dispatch(pool, message) {
  for (const s of pool.sockets) s.send(message);
}

module.exports = { createPool, addSocket, dispatch };
`,
        },
      ],
    },
  ],
  baseCommit: {
    message: 'Add a low-latency fast-reconnect path for the new mobile client',
    files: [
      {
        path: 'src/relay.cjs',
        content: `// Fans a message out to every socket registered for a room.
function createPool() {
  return { sockets: new Set(), fastSockets: [] };
}

function addSocket(pool, socket) {
  if (pool.sockets.has(socket)) return; // reconnect can re-add the same socket
  pool.sockets.add(socket);
}

// Low-latency path used by the mobile client's fast-reconnect flow: skips
// the normal handshake and re-registers the socket directly.
function fastReconnect(pool, socket) {
  pool.fastSockets.push(socket);
}

function dispatch(pool, message) {
  for (const s of pool.sockets) s.send(message);
  for (const s of pool.fastSockets) s.send(message);
}

module.exports = { createPool, addSocket, fastReconnect, dispatch };
`,
      },
    ],
  },
  goldFix: null,
  taskPrompt: `Some users on the new mobile fast-reconnect path are receiving duplicate
messages. Fix src/relay.cjs so that calling fastReconnect() for a socket
that is already registered (e.g. via addSocket) never causes dispatch() to
send that socket a message more than once, while keeping the fast path fast
for a genuinely new socket. Do not reintroduce the older duplicate-dispatch
bug that addSocket() already guards against.`,
  hiddenTestFile: `const test = require('node:test');
const assert = require('node:assert/strict');
const { createPool, addSocket, fastReconnect, dispatch } = require('../src/relay.cjs');

test('fastReconnect on an already-registered socket does not duplicate dispatch', () => {
  const pool = createPool();
  const sent = [];
  const socket = { send: (m) => sent.push(m) };
  addSocket(pool, socket);
  fastReconnect(pool, socket);
  dispatch(pool, 'hello');
  assert.equal(sent.length, 1);
});

test('fastReconnect on a genuinely new socket still delivers exactly once', () => {
  const pool = createPool();
  const sent = [];
  const socket = { send: (m) => sent.push(m) };
  fastReconnect(pool, socket);
  dispatch(pool, 'hello');
  assert.equal(sent.length, 1);
});

test('the original addSocket regression stays fixed (double addSocket is still idempotent)', () => {
  const pool = createPool();
  const sent = [];
  const socket = { send: (m) => sent.push(m) };
  addSocket(pool, socket);
  addSocket(pool, socket);
  dispatch(pool, 'hello');
  assert.equal(sent.length, 1);
});

test('two distinct sockets both receive the message once each', () => {
  const pool = createPool();
  const sentA = [];
  const sentB = [];
  const a = { send: (m) => sentA.push(m) };
  const b = { send: (m) => sentB.push(m) };
  addSocket(pool, a);
  fastReconnect(pool, b);
  dispatch(pool, 'hi');
  assert.equal(sentA.length, 1);
  assert.equal(sentB.length, 1);
});
`,
  rubric: null,
  successNote:
    'New reproduction (fastReconnect duplication) and the prior regression test (addSocket idempotency) both pass.',
};
