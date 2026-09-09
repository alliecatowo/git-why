import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZVecCreateAndOpen } from '@zvec/zvec';
import {
  historyCollectionSchema,
  buildCommitDoc,
  buildEvidenceDoc,
  ZvecHistoryStore,
} from '../../../src/index/collection.js';
import path from 'node:path';
import { freshTmpDir, rmDir, makeExtraction, makeFakeEmbedder, fakeSha } from './helpers.js';
import type { StorageFilter } from '../../../src/types.js';
import { NO_FILTERS } from '../../../src/types.js';

const DIM = 8;

async function seededStore(dir: string) {
  const collection = ZVecCreateAndOpen(path.join(dir, 'collection'), historyCollectionSchema({ embeddingDimension: DIM }));
  const embedder = makeFakeEmbedder(DIM);

  const specs = [
    { sha: fakeSha('one'), subject: 'Fix null pointer in AuthSessionProvider', committerTime: 1000, paths: ['src/auth/session.ts'] },
    { sha: fakeSha('two'), subject: 'Bump postgres to 13.9', committerTime: 2000, paths: ['docker-compose.yml'], author: { name: 'Bob', email: 'bob@example.com', time: 2000 } },
    { sha: fakeSha('three'), subject: 'Refactor evidence chunking', committerTime: 3000, paths: ['src/history/chunk.ts', 'src/history/budget.ts'] },
  ];

  for (const spec of specs) {
    const extraction = makeExtraction(spec);
    const texts = [extraction.commit.semanticText, ...extraction.evidence.map((e) => e.semanticText)];
    const vectors = await embedder.embedDocuments(texts);
    const commitDoc = buildCommitDoc({ record: extraction.commit, vector: vectors[0]! });
    const evidenceDocs = extraction.evidence.map((e, i) =>
      buildEvidenceDoc({ record: e, vector: vectors[i + 1]!, committerTime: extraction.commit.committerTime, author: extraction.commit.author }),
    );
    collection.upsertSync([commitDoc, ...evidenceDocs]);
  }

  return { collection, specs, embedder };
}

function filterFor(recordTypes: readonly ('commit' | 'evidence')[], overrides: Partial<StorageFilter['filters']> = {}): StorageFilter {
  return { recordTypes, filters: { ...NO_FILTERS, ...overrides } };
}

test('searchLexical finds commits by identifier and honours record-type eligibility', async () => {
  const dir = freshTmpDir('collection-lexical');
  try {
    const { collection } = await seededStore(dir);
    const store = new ZvecHistoryStore(collection);
    const hits = await store.searchLexical('AuthSessionProvider', filterFor(['commit']), 10);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.type, 'commit');

    const evidenceOnly = await store.searchLexical('AuthSessionProvider', filterFor(['evidence']), 10);
    assert.equal(evidenceOnly.length, 0, 'commit-only match must not leak into an evidence-only search');
    await store.close();
  } finally {
    rmDir(dir);
  }
});

test('searchSemantic returns the eligible commit as the closest match to its own vector', async () => {
  const dir = freshTmpDir('collection-semantic');
  try {
    const { collection, specs, embedder } = await seededStore(dir);
    const store = new ZvecHistoryStore(collection);
    const target = specs[0]!;
    const queryVector = await embedder.embedQuery(`Change ${target.sha.slice(0, 8)}\n${target.paths[0]}`);
    const hits = await store.searchSemantic(queryVector, filterFor(['commit']), 3);
    assert.ok(hits.length > 0);
    assert.equal(hits[0]!.sha, target.sha);
    await store.close();
  } finally {
    rmDir(dir);
  }
});

test('date-range and author filters apply to search, and path restrictions match on directory prefixes', async () => {
  const dir = freshTmpDir('collection-filters');
  try {
    const { collection } = await seededStore(dir);
    const store = new ZvecHistoryStore(collection);

    const afterOnly = await store.searchLexical('postgres', filterFor(['commit'], { after: 1500 }), 10);
    assert.equal(afterOnly.length, 1);

    const tooLate = await store.searchLexical('postgres', filterFor(['commit'], { after: 2500 }), 10);
    assert.equal(tooLate.length, 0);

    const authorMatch = await store.searchLexical('postgres', filterFor(['commit'], { author: 'bob' }), 10);
    assert.equal(authorMatch.length, 1);
    const authorMiss = await store.searchLexical('postgres', filterFor(['commit'], { author: 'nobody' }), 10);
    assert.equal(authorMiss.length, 0);

    const byDir = await store.searchLexical('chunking', filterFor(['commit'], { paths: [{ value: 'src/history', kind: 'directory' }] }), 10);
    assert.equal(byDir.length, 1);
    const wrongDir = await store.searchLexical('chunking', filterFor(['commit'], { paths: [{ value: 'src/auth', kind: 'directory' }] }), 10);
    assert.equal(wrongDir.length, 0);

    await store.close();
  } finally {
    rmDir(dir);
  }
});

test('fetchCommits and fetchEvidence round-trip full records and never include embeddings', async () => {
  const dir = freshTmpDir('collection-fetch');
  try {
    const { collection, specs } = await seededStore(dir);
    const store = new ZvecHistoryStore(collection);

    const commits = await store.fetchCommits([specs[0]!.sha, specs[1]!.sha]);
    assert.equal(commits.size, 2);
    const c0 = commits.get(specs[0]!.sha)!;
    assert.equal(c0.subject, 'Fix null pointer in AuthSessionProvider');
    assert.ok(!('vector' in c0) && !('embedding' in c0));

    const evidence = await store.evidenceForCommit(specs[2]!.sha, filterFor(['evidence']), 10);
    assert.equal(evidence.length, 1);
    const byId = await store.fetchEvidence(evidence.map((e) => e.id));
    assert.equal(byId.size, 1);
    assert.equal(byId.get(evidence[0]!.id)!.sha, specs[2]!.sha);

    await store.close();
  } finally {
    rmDir(dir);
  }
});

test('eligibility filter is applied before top-k, not after (real ZvecHistoryStore, not just raw Zvec)', async () => {
  const dir = freshTmpDir('collection-topk');
  try {
    const dim = 32;
    const collection = ZVecCreateAndOpen(path.join(dir, 'collection'), historyCollectionSchema({ embeddingDimension: dim }));
    const embedder = makeFakeEmbedder(dim);

    // 300 "noise" commits that will out-rank the 3 eligible ones for any query.
    const noiseTexts = Array.from({ length: 300 }, (_, i) => `noise commit body number ${i} unrelated content`);
    const noiseVectors = await embedder.embedDocuments(noiseTexts);
    const noiseDocs = noiseTexts.map((text, i) => {
      const extraction = makeExtraction({ sha: fakeSha(`noise-${i}`), subject: text, paths: ['other/file.ts'] });
      return buildCommitDoc({ record: { ...extraction.commit, semanticText: text }, vector: noiseVectors[i]! });
    });
    collection.upsertSync(noiseDocs);

    const eligibleSpecs = Array.from({ length: 3 }, (_, i) => ({ sha: fakeSha(`eligible-${i}`), subject: `eligible target ${i}`, paths: ['target/dir/file.ts'] }));
    const eligibleVectors = await embedder.embedDocuments(eligibleSpecs.map((s) => s.subject));
    const eligibleDocs = eligibleSpecs.map((spec, i) => {
      const extraction = makeExtraction({ sha: spec.sha, subject: spec.subject, paths: spec.paths });
      return buildCommitDoc({ record: { ...extraction.commit, semanticText: spec.subject }, vector: eligibleVectors[i]! });
    });
    collection.upsertSync(eligibleDocs);

    const store = new ZvecHistoryStore(collection);
    const queryVector = await embedder.embedQuery('completely unrelated query text');
    const hits = await store.searchSemantic(queryVector, filterFor(['commit'], { paths: [{ value: 'target/dir', kind: 'directory' }] }), 3);
    assert.equal(hits.length, 3);
    const expected = new Set(eligibleSpecs.map((s) => s.sha));
    for (const hit of hits) assert.ok(expected.has(hit.sha), `${hit.sha} should be one of the 3 eligible docs, not a noise doc`);

    await store.close();
  } finally {
    rmDir(dir);
  }
});
