#!/usr/bin/env node
/**
 * Measures what a resident process would buy: the same query run N times
 * inside ONE process against a real index, versus the fresh-process latency
 * the CLI actually delivers today.
 *
 * This exists because the roadmap claimed a daemon would recover about 12% of
 * a query, and that figure came from measuring `git why status` — process
 * start plus opening the index, retrieving nothing. That is the FLOOR of what
 * a resident process saves, not the ceiling: it captures none of the resident
 * embedding model, the warm collection pages, or the amortised index open.
 * Asserting the floor as the answer was wrong, so this measures the thing
 * itself.
 *
 *   node spike/resident-query.mjs <repo> [iterations]
 */

import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const repoPath = resolve(process.argv[2] ?? '.');
const iterations = Number(process.argv[3] ?? 8);

const { createBackend } = await import('../dist/cli/wire.js');
const { decomposeQuery } = await import('../dist/search/temporal/intent.js');

const QUERIES = [
  'why do we retry on connection reset',
  'what was that bug with duplicate headers',
  'why is the connection cache keyed this way',
  'what made the TLS handshake fail on reuse',
];

const options = {
  offline: false,
  noRefresh: true, // read-only: this must not mutate the clone it measures
  lockTimeoutMs: 30_000,
  signal: new AbortController().signal,
  onProgress: () => {},
};

const backend = await createBackend();

const t0 = performance.now();
const repo = await backend.openRepository(repoPath);
const openMs = performance.now() - t0;

const requestFor = (query) => {
  const decomposition = decomposeQuery(query);
  return {
    query,
    mode: 'hybrid',
    sort: 'relevance',
    limit: 5,
    filters: { paths: [], after: null, before: null, author: null },
    temporal: decomposition.constraint,
    groups: [],
    owners: false,
  };
};

const samples = [];
for (let i = 0; i < iterations; i++) {
  const query = QUERIES[i % QUERIES.length];
  const start = performance.now();
  const response = await backend.search(repo, requestFor(query), options);
  const ms = performance.now() - start;
  samples.push({ i, ms, results: response.results.length });
}

const median = (xs) => {
  const v = [...xs].sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
};

const first = samples[0].ms;
const rest = samples.slice(1).map((s) => s.ms);

console.log(`repo:            ${repoPath}`);
console.log(`openRepository:  ${openMs.toFixed(0)} ms  (once)`);
console.log(`query 1:         ${first.toFixed(0)} ms  (cold: model load, first collection touch)`);
console.log(
  `queries 2..${iterations}:      median ${median(rest).toFixed(0)} ms, min ${Math.min(...rest).toFixed(0)}, max ${Math.max(...rest).toFixed(0)}`,
);
console.log(`\nper-query:`);
for (const s of samples)
  console.log(
    `  ${String(s.i + 1).padStart(2)}  ${s.ms.toFixed(0).padStart(6)} ms  (${s.results} results)`,
  );
