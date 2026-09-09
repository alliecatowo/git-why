// Fixture 2: a background job queue that migrated from an in-process
// array-based queue to a worker-pool model.
// Covers: deleted_implementation (x2), poor_message_rich_diff (x1),
// no_evidence handled via corpus only, plus churn/version filler.

const SUBSYS = { queue: 'queue', worker: 'worker', metrics: 'metrics' };

const initialFiles = [
  {
    path: 'src/queue/array-queue.js',
    subsystem: SUBSYS.queue,
    content: `// The original job queue: a plain in-process array, processed by a
// single setInterval loop. Simple but has no concurrency and no
// backpressure -- superseded by the worker pool.
export class ArrayQueue {
  constructor() {
    this.items = [];
  }
  push(job) {
    this.items.push(job);
  }
  drain(handler) {
    while (this.items.length > 0) {
      handler(this.items.shift());
    }
  }
}
`,
  },
  {
    path: 'src/worker/pool.js',
    subsystem: SUBSYS.worker,
    content: `// Fixed-size worker pool. Jobs are pulled from a shared queue by
// whichever worker is free.
export class WorkerPool {
  constructor(size) {
    this.size = size;
    this.busy = 0;
  }
  acquire() {
    if (this.busy >= this.size) return null;
    this.busy++;
    return true;
  }
  release() {
    this.busy--;
  }
}
`,
  },
  {
    path: 'src/metrics/counters.js',
    subsystem: SUBSYS.metrics,
    content: `// Simple in-memory counters for queue depth and job throughput.
export const counters = { enqueued: 0, processed: 0, failed: 0 };
`,
  },
  { path: 'README.md', subsystem: 'docs', content: '# task-queue\n\nBackground job processing.\n' },
];

const beats = [
  // --- deleted_implementation #1 (dev): the array queue removed ---
  {
    id: 'queue.remove-array-queue',
    category: 'deleted_implementation',
    subsystem: SUBSYS.queue,
    subject: 'Delete ArrayQueue now that WorkerPool handles all job intake',
    body: `Every caller has moved to WorkerPool.submit(). ArrayQueue's drain()
loop ran on a single timer and could not process jobs concurrently,
which was the original motivation for the worker pool. Removing the
dead code rather than keeping it as a fallback.`,
    files: [{ path: 'src/queue/array-queue.js', op: 'remove' }],
    note: 'The deleted queue implementation itself is the expected evidence for "the queue before we moved to workers".',
  },
  // --- poor_message_rich_diff (dev): terse subject, real fix in diff ---
  {
    id: 'worker.fix-issue-2',
    category: 'poor_message_rich_diff',
    subsystem: SUBSYS.worker,
    subject: 'wip',
    body: '',
    files: [
      {
        path: 'src/worker/pool.js',
        op: 'write',
        content: `// Fixed-size worker pool. Jobs are pulled from a shared queue by
// whichever worker is free.
export class WorkerPool {
  constructor(size) {
    this.size = size;
    this.busy = 0;
  }
  acquire() {
    if (this.busy >= this.size) return null;
    this.busy++;
    return true;
  }
  release() {
    // Guard against release() being called more times than acquire():
    // a retried job that double-released was driving busy negative and
    // let more jobs run concurrently than "size" allowed.
    if (this.busy > 0) this.busy--;
  }
}
`,
      },
    ],
    note: 'Subject "wip" carries no signal; the guarded release() and its comment are the only evidence for a query about over-concurrent workers.',
  },
  // --- deleted_implementation #2 (test): the polling submit path removed ---
  {
    id: 'worker.remove-polling-submit',
    category: 'deleted_implementation',
    subsystem: SUBSYS.worker,
    subject: 'Remove WorkerPool.pollForWork(), replaced by push-based submit()',
    body: `pollForWork() had every idle worker ask the queue for work every
50ms. It was replaced by submit() pushing directly to a free worker,
removing the polling overhead entirely.`,
    files: [
      {
        path: 'src/worker/poll-legacy.js',
        op: 'remove',
      },
    ],
    note: 'A second deleted-implementation case in the same fixture, targeting a different removed function than the array queue.',
  },
];

const distractorBeats = [
  {
    id: 'distractor.metrics-refactor',
    category: 'distractor',
    subsystem: SUBSYS.metrics,
    subject: 'Refactor counters into a class for testability',
    body: 'Cosmetic refactor of the metrics module; not related to queue/worker migration.',
    files: [
      {
        path: 'src/metrics/counters.js',
        op: 'write',
        content: `// Counters wrapped in a class purely for easier mocking in tests.
export class Counters {
  constructor() {
    this.enqueued = 0;
    this.processed = 0;
    this.failed = 0;
  }
}
export const counters = new Counters();
`,
      },
    ],
    note: 'Looks like it could be "the old counters implementation" but is an unrelated refactor, not a deletion.',
  },
];

export default {
  id: 'task-queue',
  seed: 'git-why-bench::task-queue::v1',
  theme: 'Background job queue migrating from an array loop to a worker pool.',
  baseEpochSeconds: 1_705_000_000,
  initialFiles: [
    ...initialFiles,
    {
      path: 'src/worker/poll-legacy.js',
      subsystem: SUBSYS.worker,
      content: `// Legacy polling loop: every idle worker asks the queue for work on
// a fixed interval. Superseded by push-based submit().
export function pollForWork(pool, queue, intervalMs) {
  return setInterval(() => {
    if (pool.acquire() && queue.items.length > 0) {
      // ...
    }
  }, intervalMs);
}
`,
    },
  ],
  beats,
  fillerPlan: { count: 130, versionBumpFraction: 0.15, distractorBeats },
};
