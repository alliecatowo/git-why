// Fixture 4: an ETL pipeline with a Postgres sink and a Redis-based lock
// that gets migrated away.
// Covers: migration (x4), number_version (x2), rich_message_skipped_patch
// (x1), no_evidence handled via corpus only.

const SUBSYS = { locking: 'locking', export: 'export', db: 'db' };

const initialFiles = [
  {
    path: 'src/locking/redis-lock.js',
    subsystem: SUBSYS.locking,
    content: `// Distributed lock backed by a single Redis instance. Used to make
// sure only one pipeline worker processes a given batch at a time.
export async function acquireLock(client, key, ttlMs) {
  return client.set(key, '1', 'NX', 'PX', ttlMs);
}
`,
  },
  {
    path: 'src/export/csv-export.js',
    subsystem: SUBSYS.export,
    content: `// Builds the full export as one in-memory CSV string, then writes it.
export function buildCsv(rows) {
  return rows.map((r) => Object.values(r).join(',')).join('\\n');
}
`,
  },
  {
    path: 'src/db/schema.js',
    subsystem: SUBSYS.db,
    content: `// Records the minimum supported Postgres version for this pipeline.
export const MIN_POSTGRES_VERSION = 11;
`,
  },
  { path: 'package-lock.snapshot.txt', subsystem: 'deps', content: 'lodash@4.17.20\n' },
];

const beats = [
  // --- migration #1 (dev): redis locks -> postgres advisory locks, decision ---
  {
    id: 'locking.migrate-to-postgres-advisory-locks',
    category: 'migration',
    subsystem: SUBSYS.locking,
    subject: 'Migrate batch locking from Redis to Postgres advisory locks',
    body: `Redis-backed locks were released early during a Redis primary
failover in incident INC-1142: the replica promoted to primary did
not have the key yet, so a second worker acquired the "same" lock
and processed a batch twice. Postgres advisory locks live in the
same transaction as the batch write, so a failover there can't
strand or duplicate a lock the way the standalone Redis instance did.
This is the actual constraint driving the migration, not a general
Redis dislike.`,
    files: [
      {
        path: 'src/locking/postgres-lock.js',
        op: 'write',
        content: `// Distributed lock backed by a Postgres advisory lock, held for the
// duration of the transaction that processes a batch. See commit
// message for why this replaced the Redis-backed lock.
export async function withAdvisoryLock(pgClient, lockId, fn) {
  await pgClient.query('SELECT pg_advisory_xact_lock($1)', [lockId]);
  return fn();
}
`,
      },
    ],
    note: 'Real migration constraint (failover data loss), not a generic "we prefer Postgres" statement.',
  },
  // --- number_version #1 (dev): drop postgres 13 ---
  {
    id: 'db.drop-postgres-13',
    category: 'number_version',
    subsystem: SUBSYS.db,
    subject: 'Require Postgres 14+; drop support for Postgres 13',
    body: `pg_advisory_xact_lock's interaction with parallel query workers was
fixed in Postgres 14 (see release notes); on 13 a parallel worker
could take a session-level lock that looked released to the leader.
Since the previous migration commit moved batch locking onto
advisory locks, staying on 13 would silently reintroduce the
duplicate-processing bug. Bumping the minimum version accordingly.`,
    files: [
      {
        path: 'src/db/schema.js',
        op: 'write',
        content: `// Records the minimum supported Postgres version for this pipeline.
// Postgres 13 is unsupported: see commit message (advisory lock +
// parallel worker interaction fixed only in 14+).
export const MIN_POSTGRES_VERSION = 14;
`,
      },
    ],
    note: 'Must be distinguished from unrelated numeric distractors (Node version bumps, dependency versions) and from nearby Postgres versions (12, 15) mentioned only in filler.',
  },
  // --- rich_message_skipped_patch (dev) ---
  {
    id: 'deps.pin-pg-driver',
    category: 'rich_message_skipped_patch',
    subsystem: 'deps',
    subject: 'Pin the pg driver to 8.11.3 to avoid a connection-pool leak',
    body: `pg@8.11.4 through 8.11.5 has a regression (upstream issue #2911)
where a connection acquired during a failed advisory-lock query is
never returned to the pool, exhausting it after roughly 400 failed
lock attempts. Pinning to the last known-good 8.11.3 until upstream
ships a fix. This only touches the lockfile snapshot; there is no
application code change.`,
    files: [
      {
        path: 'package-lock.snapshot.txt',
        op: 'write',
        content: 'lodash@4.17.20\npg@8.11.3\n',
      },
    ],
    note: 'The message carries the entire rationale; a policy that skips lockfile patches must still let this be found and explained from the message alone.',
  },
  // --- migration #2 (test): csv -> streaming export, decision ---
  {
    id: 'export.migrate-to-streaming-ndjson',
    category: 'migration',
    subsystem: SUBSYS.export,
    subject: 'Replace in-memory CSV export with streaming NDJSON',
    body: `buildCsv() materializes the entire export as one string before
writing anything, which OOM'd the export worker on the "all
customers" report once the table passed roughly 4M rows (container
limit is 2GiB). Streaming NDJSON writes one row at a time and never
holds more than a constant amount of memory. CSV format itself was
not the problem; the eager, whole-string construction was.`,
    files: [
      {
        path: 'src/export/streaming-export.js',
        op: 'write',
        content: `// Streams rows as newline-delimited JSON instead of building the
// whole export in memory. See commit message for the OOM this fixes.
export async function* streamNdjson(rows) {
  for (const row of rows) {
    yield JSON.stringify(row) + '\\n';
  }
}
`,
      },
    ],
    note: 'Real migration constraint (OOM at ~4M rows), distinct from the locking migration in the same fixture.',
  },
  // --- migration #3 (test): remove the old csv export now unused ---
  {
    id: 'export.remove-csv-export',
    category: 'migration',
    subsystem: SUBSYS.export,
    subject: 'Delete buildCsv() now that every caller uses streamNdjson()',
    body: 'Follow-up cleanup after the streaming export migration; no remaining callers.',
    files: [{ path: 'src/export/csv-export.js', op: 'remove' }],
    note: 'Completes the export migration story; relevant to a query about why CSV export was replaced.',
  },
  // --- migration #4 (test) ---
  {
    id: 'locking.remove-redis-lock-file',
    category: 'migration',
    subsystem: SUBSYS.locking,
    subject: 'Delete the Redis lock implementation now unused',
    body: 'All callers moved to withAdvisoryLock(); removing the dead Redis lock code.',
    files: [{ path: 'src/locking/redis-lock.js', op: 'remove' }],
    note: 'Fourth migration-category commit: completes the locking migration story.',
  },
  // --- number_version #2 (test): require Node 18 for the streaming export ---
  {
    id: 'export.require-node-18-streams',
    category: 'number_version',
    subsystem: SUBSYS.export,
    subject: 'Require Node 18+ for the streaming export path',
    body: `streamNdjson() relies on ReadableStream.from() semantics for async
generators that only landed correctly in Node 18 (Node 16's
implementation drops the final chunk under backpressure, verified
locally against Node 16.20 and Node 18.16). Bumping the engines
requirement rather than adding a Node-16 polyfill for a runtime
already past its support window.`,
    files: [
      {
        path: 'src/export/streaming-export.js',
        op: 'write',
        content: `// Streams rows as newline-delimited JSON instead of building the
// whole export in memory. Requires Node 18+: see commit message
// (Node 16's ReadableStream.from() drops the final chunk under
// backpressure).
export async function* streamNdjson(rows) {
  for (const row of rows) {
    yield JSON.stringify(row) + '\\n';
  }
}
`,
      },
    ],
    note: 'Second number_version case in this fixture, distinguished from the Postgres 13 drop and from unrelated Node-version filler mentions.',
  },
];

const distractorBeats = [
  {
    id: 'distractor.redis-cache-timeout',
    category: 'distractor',
    subsystem: SUBSYS.locking,
    subject: 'Increase the Redis session-cache read timeout to 200ms',
    body: 'Unrelated Redis change: this is the separate Redis-backed read cache, not the batch lock that was migrated away.',
    files: [
      {
        path: 'src/locking/redis-cache-config.js',
        op: 'write',
        content: `// Config for the unrelated Redis read-through cache (not the batch
// lock discussed elsewhere in this history).
export const READ_CACHE_TIMEOUT_MS = 200;
`,
      },
    ],
    note: 'Distractor for the "why stop using redis locks" migration query: same technology, unrelated subsystem.',
  },
  {
    id: 'distractor.node-version-bump',
    category: 'distractor',
    subsystem: 'deps',
    subject: 'Require Node 20; drop support for Node 18',
    body: 'Routine runtime bump unrelated to the Postgres 13 drop.',
    files: [{ path: '.node-version-snapshot.txt', op: 'write', content: '20\n' }],
    note: 'Distractor for the "why drop postgres 13" number/version query: a different product with a similarly shaped version-drop message.',
  },
  {
    id: 'distractor.postgres-15-mention',
    category: 'distractor',
    subsystem: SUBSYS.db,
    subject: 'Document Postgres 15 compatibility in the ops runbook',
    body: 'Documentation only; does not change MIN_POSTGRES_VERSION or drop support for anything.',
    files: [{ path: 'docs/postgres-15-notes.md', op: 'write', content: '# Postgres 15 notes\n\nCompatible, no action needed.\n' }],
    note: 'Nearby-version distractor: mentions a different Postgres version number in an unrelated context.',
  },
];

export default {
  id: 'data-pipeline',
  seed: 'git-why-bench::data-pipeline::v1',
  theme: 'ETL pipeline: batch locking, CSV/NDJSON export, Postgres minimum version.',
  baseEpochSeconds: 1_715_000_000,
  initialFiles,
  beats,
  fillerPlan: { count: 150, versionBumpFraction: 0.2, distractorBeats },
};
