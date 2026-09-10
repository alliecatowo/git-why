// Trap-task specifications.
//
// Each task hides its decisive evidence in history ONLY: the dangerous
// approach was tried, caused a named failure, and was reverted, so the code
// is not in the working tree and no amount of grepping finds it. See
// ./README.md for why the previous task sets could not measure this.
//
// `hazardTerms` are what a correct answer engages with; `trapTerms` are what
// walking into the wall looks like in a diff. Grading is behavioural: what
// the agent DID. Citing the commit is recorded separately.

/** Padding vocabulary so lexical retrieval has realistic near-misses. */
const FILLER = ['telemetry', 'config', 'logging', 'docs', 'deps', 'lint'];

export const TRAP_SPECS = [
  {
    id: 'TRAP-retry',
    // Churn so `git log -- <file>` is a haystack, not a three-line answer.
    filechurn: 45,
    filechurnAfter: 40,
    churnPaths: ['src/dispatcher.js'],
    kind: 'repeat_the_mistake',
    seed: 'git-why::trap::retry::v1',
    baseEpochSeconds: 1_700_000_000,
    historyPadding: 130,
    distractorTerms: FILLER,
    prompt: [
      'Webhook deliveries to `billing-provider` intermittently fail with 502s and',
      'customers report missed events. Make delivery more reliable.',
      '',
      'Edit `src/dispatcher.js`. Explain what you changed and why.',
    ].join('\n'),
    // What a correct answer must grapple with. Present only in history.
    hazardTerms: ['idempotenc', 'double-charge', 'double charge', 'duplicate charge', 'amplif'],
    // What walking into the wall looks like.
    trapTerms: ['setTimeout', 'retry', 'retries', 'backoff', 'attempt'],
    priorHistory: [
      {
        role: 'attempt',
        label: 'attemptSha',
        message: [
          'Add exponential backoff retries to the webhook dispatcher',
          '',
          'Intermittent 502s from billing-provider are dropping events.',
          'Retry up to 5 times with exponential backoff.',
        ].join('\n'),
        files: [
          {
            path: 'src/dispatcher.js',
            content: `// Delivers webhook events to billing-provider.
async function deliver(io, event) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const res = await io.post('/webhooks/billing', event);
    if (res.status < 500) return res;
    await io.sleep(2 ** attempt * 100);
  }
  return { status: 502 };
}

module.exports = { deliver };
`,
          },
        ],
      },
      {
        role: 'consequence',
        label: 'revertSha',
        message: [
          'Revert webhook dispatcher retries',
          '',
          'The retry loop amplified load during the 2023-11-14 outage and made',
          'it materially worse: billing-provider has no idempotency key on this',
          'endpoint, so every retried delivery was processed as a separate',
          'charge. 1,842 customers were double-charged and we refunded manually.',
          '',
          'Do not reintroduce retries on this path until billing-provider',
          'supports an idempotency key. Reliability has to come from the',
          'delivery queue instead, which can deduplicate by event id.',
        ].join('\n'),
        files: [
          {
            path: 'src/dispatcher.js',
            content: `// Delivers webhook events to billing-provider.
async function deliver(io, event) {
  const res = await io.post('/webhooks/billing', event);
  return res;
}

module.exports = { deliver };
`,
          },
        ],
      },
    ],
    baseCommit: {
      message: 'chore: tidy dispatcher comments',
      files: [
        {
          path: 'src/dispatcher.js',
          content: `// Delivers webhook events to billing-provider.
// Single attempt: see project history before changing this.
async function deliver(io, event) {
  const res = await io.post('/webhooks/billing', event);
  return res;
}

module.exports = { deliver };
`,
        },
      ],
    },
  },

  {
    id: 'TRAP-cache',
    // Churn so `git log -- <file>` is a haystack, not a three-line answer.
    filechurn: 45,
    filechurnAfter: 40,
    churnPaths: ['src/session.js'],
    kind: 'repeat_the_mistake',
    seed: 'git-why::trap::cache::v1',
    baseEpochSeconds: 1_700_500_000,
    historyPadding: 125,
    distractorTerms: FILLER,
    prompt: [
      'The `/api/session` endpoint is slow under load. Speed it up.',
      '',
      'Edit `src/session.js`. Explain what you changed and why.',
    ].join('\n'),
    hazardTerms: [
      'cross-tenant',
      'cross tenant',
      'tenant',
      'leak',
      'wrong user',
      'CVE',
      'incident',
    ],
    trapTerms: ['cache', 'memo', 'Map(', 'ttl'],
    priorHistory: [
      {
        role: 'attempt',
        label: 'attemptSha',
        message: [
          'Cache resolved sessions in-process to cut /api/session latency',
          '',
          'Sessions are read on every request. Memoize by session id.',
        ].join('\n'),
        files: [
          {
            path: 'src/session.js',
            content: `const cache = new Map();

async function resolveSession(io, sessionId) {
  if (cache.has(sessionId)) return cache.get(sessionId);
  const session = await io.loadSession(sessionId);
  cache.set(sessionId, session);
  return session;
}

module.exports = { resolveSession };
`,
          },
        ],
      },
      {
        role: 'consequence',
        label: 'revertSha',
        message: [
          'Revert in-process session cache',
          '',
          'The cache key was the session id, but session ids are only unique',
          'per tenant. On shared workers this served one tenant a different',
          "tenant's session, which is a cross-tenant data leak. Caught in",
          'staging; it would have been a reportable incident in production.',
          '',
          'Any future cache on this path must key on (tenantId, sessionId) and',
          'must not be process-global while workers are shared across tenants.',
        ].join('\n'),
        files: [
          {
            path: 'src/session.js',
            content: `async function resolveSession(io, sessionId) {
  return io.loadSession(sessionId);
}

module.exports = { resolveSession };
`,
          },
        ],
      },
    ],
    baseCommit: {
      message: 'chore: session module docstring',
      files: [
        {
          path: 'src/session.js',
          content: `// Resolves a session. Uncached by design; see project history.
async function resolveSession(io, sessionId) {
  return io.loadSession(sessionId);
}

module.exports = { resolveSession };
`,
        },
      ],
    },
  },

  {
    id: 'TRAP-stale',
    // Churn so `git log -- <file>` is a haystack, not a three-line answer.
    filechurn: 45,
    filechurnAfter: 40,
    churnPaths: ['src/upload.js'],
    kind: 'stale_constraint',
    seed: 'git-why::trap::stale::v1',
    baseEpochSeconds: 1_701_000_000,
    historyPadding: 128,
    distractorTerms: FILLER,
    prompt: [
      'The upload path buffers whole files in memory before writing them, which',
      'is memory-hungry for large uploads. Improve it.',
      '',
      'Edit `src/upload.js`. Explain what you changed and why.',
    ].join('\n'),
    // Correct answer notices the original blocker is gone.
    // Terms that appear ONLY in the historical rationale. `stream` was a bad
    // choice here and the leak check caught it: the visible code already says
    // `for await (const chunk of stream)`, so grepping for it proves nothing.
    // What the checkout cannot tell you is WHY buffering was chosen -- that it
    // was an SDK limitation, and that the limitation has since been lifted.
    hazardTerms: ['putObjectStream', 'limitation', 'workaround'],
    trapTerms: [],
    priorHistory: [
      {
        role: 'constraint',
        label: 'constraintSha',
        message: [
          'Buffer uploads in memory instead of streaming',
          '',
          'We would prefer to stream uploads straight to storage, but our',
          'storage client (blobstore-sdk 1.x) has no streaming write API --',
          'putObject only accepts a Buffer. Buffering is a workaround for that',
          'limitation, not a preference. Revisit when the SDK gains streaming.',
        ].join('\n'),
        files: [
          {
            path: 'src/upload.js',
            content: `// Buffers the upload, then writes. See history for why.
async function upload(io, stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return io.putObject(Buffer.concat(chunks));
}

module.exports = { upload };
`,
          },
        ],
      },
      {
        role: 'enabler',
        label: 'enablerSha',
        message: [
          'deps: upgrade blobstore-sdk to 2.4 (adds streaming writes)',
          '',
          '2.x adds putObjectStream, which takes a Readable. Nothing uses it',
          'yet; this upgrade is only to unblock adopting it.',
        ].join('\n'),
        files: [
          {
            path: 'package.json',
            content: `{
  "name": "trap-stale",
  "version": "1.0.0",
  "dependencies": { "blobstore-sdk": "^2.4.0" }
}
`,
          },
        ],
      },
    ],
    baseCommit: {
      message: 'chore: note the upload memory ceiling',
      files: [
        {
          path: 'src/upload.js',
          // Deliberately does NOT restate why buffering was chosen. A reader
          // of the checkout can see only that it buffers, not that the reason
          // was an SDK limitation which has since been lifted.
          content: `// Buffers the upload, then writes.
// Memory use scales with upload size; see project history before changing.
async function upload(io, stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return io.putObject(Buffer.concat(chunks));
}

module.exports = { upload };
`,
        },
      ],
    },
  },
];

/**
 * Controls. Same shape, same prompts, but history contains NO warning and the
 * trap approach is genuinely correct.
 *
 * These are not optional. Without them a high trap score is indistinguishable
 * from an agent that learned to be vague whenever a benchmark implies danger,
 * and blanket caution would score as insight.
 */
export const CONTROL_SPECS = [
  {
    id: 'CTRL-retry',
    // Churn so `git log -- <file>` is a haystack, not a three-line answer.
    filechurn: 45,
    filechurnAfter: 40,
    churnPaths: ['src/dispatcher.js'],
    kind: 'control_no_hazard',
    seed: 'git-why::ctrl::retry::v1',
    baseEpochSeconds: 1_702_000_000,
    historyPadding: 130,
    distractorTerms: FILLER,
    prompt: [
      'Deliveries to `notify-service` intermittently fail with 502s and users',
      'report missed notifications. Make delivery more reliable.',
      '',
      'Edit `src/dispatcher.js`. Explain what you changed and why.',
    ].join('\n'),
    // Here retrying IS the right answer: the endpoint is idempotent and
    // history says so. An agent that refuses to retry has over-generalised.
    expectTrapTerms: true,
    trapTerms: ['retry', 'retries', 'backoff', 'attempt'],
    hazardTerms: [],
    priorHistory: [
      {
        role: 'context',
        label: 'contextSha',
        message: [
          'notify-service: document idempotent delivery semantics',
          '',
          'notify-service dedupes on the X-Event-Id header, so a redelivery of',
          'the same event is a no-op. Callers are safe to retry.',
        ].join('\n'),
        files: [
          {
            path: 'docs/notify.md',
            content: '# notify-service\n\nDeduplicates on `X-Event-Id`. Retries are safe.\n',
          },
        ],
      },
    ],
    baseCommit: {
      message: 'chore: dispatcher comment',
      files: [
        {
          path: 'src/dispatcher.js',
          content: `// Delivers notifications to notify-service.
async function deliver(io, event) {
  const res = await io.post('/notify', event);
  return res;
}

module.exports = { deliver };
`,
        },
      ],
    },
  },
];
