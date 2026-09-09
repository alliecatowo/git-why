const test = require('node:test');
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
