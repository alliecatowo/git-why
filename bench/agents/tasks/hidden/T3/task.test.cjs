const test = require('node:test');
const assert = require('node:assert/strict');
const { WorkerPool } = require('../src/workerpool.cjs');

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test('a priority job jumps ahead of already-queued normal jobs', async () => {
  const pool = new WorkerPool(1);
  const order = [];
  let resolveA;
  pool.submit(() => new Promise((r) => (resolveA = r)).then(() => order.push('A')));
  pool.submit(() => Promise.resolve().then(() => order.push('B')));
  assert.equal(typeof pool.submitPriority, 'function', 'expected pool.submitPriority to exist');
  pool.submitPriority(() => Promise.resolve().then(() => order.push('C')));
  await wait(5);
  resolveA();
  await wait(30);
  assert.deepEqual(order, ['A', 'C', 'B']);
});

test('concurrency limit is still respected when priority jobs are used', async () => {
  const pool = new WorkerPool(2);
  let concurrent = 0;
  let maxConcurrent = 0;
  const job = () => {
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    return wait(15).then(() => {
      concurrent--;
    });
  };
  pool.submit(job);
  pool.submit(job);
  pool.submitPriority(job);
  pool.submit(job);
  await wait(80);
  assert.ok(maxConcurrent <= 2, `expected maxConcurrent <= 2, got ${maxConcurrent}`);
});
