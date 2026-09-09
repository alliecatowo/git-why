export default {
  id: 'T3',
  kind: 'deleted_approach',
  seed: 'git-why-bench::agents::T3::v1',
  baseEpochSeconds: 1_732_000_000,
  priorHistory: [
    {
      message: 'Add the initial in-process job queue',
      files: [
        {
          path: 'src/arrayqueue.cjs',
          content: `// Original in-process job queue: a plain array processed by a single
// drain loop. No concurrency control -- everything runs one at a time,
// regardless of how many jobs are queued.
class ArrayQueue {
  constructor() {
    this.items = [];
  }
  push(job) {
    this.items.push(job);
  }
  // Priority jobs jump straight to the front of the line.
  pushPriority(job) {
    this.items.unshift(job);
  }
  drain(handler) {
    while (this.items.length > 0) {
      handler(this.items.shift());
    }
  }
}
module.exports = { ArrayQueue };
`,
        },
      ],
    },
    {
      message: 'Migrate job intake to a concurrent WorkerPool',
      files: [
        {
          path: 'src/workerpool.cjs',
          content: `// Fixed-concurrency worker pool. Replaces ArrayQueue's single-threaded
// drain loop with up to \`size\` jobs running at once.
class WorkerPool {
  constructor(size) {
    this.size = size;
    this.busy = 0;
    this.queue = [];
  }
  submit(job) {
    this.queue.push(job);
    this._drain();
  }
  _drain() {
    while (this.busy < this.size && this.queue.length > 0) {
      const job = this.queue.shift();
      this.busy++;
      Promise.resolve()
        .then(job)
        .finally(() => {
          this.busy--;
          this._drain();
        });
    }
  }
}
module.exports = { WorkerPool };
`,
        },
      ],
    },
  ],
  baseCommit: {
    message: 'Delete ArrayQueue now that WorkerPool handles all job intake',
    files: [{ path: 'src/arrayqueue.cjs', op: 'remove' }],
  },
  goldFix: null,
  taskPrompt: `WorkerPool.submit() currently processes jobs strictly first-in-first-out.
Add a way to submit a job as high-priority so it is processed before
already-queued normal jobs (but not before jobs that already started
running), without exceeding the pool's configured concurrency limit
(\`size\`). The project used to have a priority concept in an older queue
implementation that was removed when the pool was introduced -- the
project's git history may show what that looked like, if it's useful.`,
  hiddenTestFile: `const test = require('node:test');
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
  assert.ok(maxConcurrent <= 2, \`expected maxConcurrent <= 2, got \${maxConcurrent}\`);
});
`,
  rubric: null,
  successNote:
    'Priority behavior restored inside the new interface without exceeding the concurrency limit (the old queue\'s known defect: no concurrency control at all).',
};
