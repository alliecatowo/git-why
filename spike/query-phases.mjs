#!/usr/bin/env node
/**
 * Attributes a query's cost to the per-call setup the backend redoes every
 * time, versus the retrieval itself.
 *
 * `Backend.search()` opens the Zvec collection, loads the embedding model,
 * shells out to git for a ref snapshot, and reads the lineage file on EVERY
 * call — then closes it all again — even if the previous call happened a
 * millisecond ago in the same process. That is why a resident process shows no
 * warm-up at all: there is nothing warm to reuse.
 *
 * This measures each step, so "would a daemon help, and by how much" has a
 * number behind it instead of an intuition. It imports product internals,
 * which bench/ may not do — that is why it lives in spike/.
 *
 *   node spike/query-phases.mjs <repo> [iterations]
 */

import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const repoPath = resolve(process.argv[2] ?? '.');
const iterations = Number(process.argv[3] ?? 5);

const { openReadOnlyStore } = await import('../dist/index/refresh.js');
const { layoutFor, generationPaths } = await import('../dist/index/layout.js');
const { loadDefaultEmbedder } = await import('../dist/embedding/candidates.js');
const { captureSnapshot } = await import('../dist/git/snapshot.js');
const { search } = await import('../dist/search/search.js');
const { JsonLineageStore } = await import('../dist/history/lineage.js');
const { decomposeQuery } = await import('../dist/search/temporal/intent.js');
const { createBackend } = await import('../dist/cli/wire.js');

const backend = await createBackend();
const repo = await backend.openRepository(repoPath);

const refreshOptions = {
  lockTimeoutMs: 30_000,
  signal: new AbortController().signal,
  onProgress: () => {},
};

const time = async (fn) => {
  const t = performance.now();
  const value = await fn();
  return { ms: performance.now() - t, value };
};

const QUERIES = [
  'why do we retry on connection reset',
  'what was that bug with duplicate headers',
  'why is the connection cache keyed this way',
];

const rows = [];
for (let i = 0; i < iterations; i++) {
  const query = QUERIES[i % QUERIES.length];
  const total = performance.now();

  const open = await time(() => openReadOnlyStore(repo.identity, refreshOptions));
  const opened = open.value;
  try {
    const embed = await time(() => loadDefaultEmbedder({ offline: false, onProgress: () => {} }));
    const snap = await time(() => captureSnapshot(repo.identity));
    const lineageT = await time(async () => {
      const l = new JsonLineageStore(
        generationPaths(layoutFor(repo.identity.commonDir), opened.generationId).lineageFile,
      );
      // JsonLineageStore is lazy; force the read so it is attributed here.
      await l.intervalsFor?.('x', []);
      return l;
    });
    const retrieval = await time(() =>
      search(
        {
          query,
          mode: 'hybrid',
          sort: 'relevance',
          limit: 5,
          filters: { paths: [], after: null, before: null, author: null },
          temporal: decomposeQuery(query).constraint,
          groups: [],
          owners: false,
        },
        opened.store,
        embed.value,
        {
          generation: opened.generationId,
          indexedAt: opened.manifest.updatedAt,
          state: 'current',
          coverage: 'complete_for_policy',
        },
        lineageT.value,
      ),
    );
    rows.push({
      open: open.ms,
      embedder: embed.ms,
      snapshot: snap.ms,
      lineage: lineageT.ms,
      retrieval: retrieval.ms,
      total: performance.now() - total,
    });
  } finally {
    await opened.store.close();
    opened.lock.release();
  }
}

const median = (xs) => {
  const v = [...xs].sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
};
const col = (k) => median(rows.map((r) => r[k]));

const total = col('total');
console.log(`\n${repoPath}`);
console.log(`${iterations} queries, each one a full Backend.search()-equivalent. Medians:\n`);
for (const k of ['open', 'embedder', 'snapshot', 'lineage', 'retrieval', 'total']) {
  const v = col(k);
  const pct = ((v / total) * 100).toFixed(0);
  console.log(
    `  ${k.padEnd(11)} ${v.toFixed(0).padStart(6)} ms  ${k === 'total' ? '' : `${pct.padStart(3)}%`}`,
  );
}
const reusable = col('open') + col('embedder') + col('snapshot') + col('lineage');
console.log(
  `\n  reusable across calls: ${reusable.toFixed(0)} ms (${((reusable / total) * 100).toFixed(0)}%)`,
);
console.log(
  `  genuine retrieval:     ${col('retrieval').toFixed(0)} ms (${((col('retrieval') / total) * 100).toFixed(0)}%)`,
);
