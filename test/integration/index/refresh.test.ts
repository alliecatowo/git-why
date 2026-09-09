import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureCurrentGeneration, rebuild, gc, openReadOnlyStore, __testHooks } from '../../../src/index/refresh.js';
import { readCurrentGenerationId, layoutFor, generationPaths } from '../../../src/index/layout.js';
import { readManifest } from '../../../src/index/manifest.js';
import type { CommitExtraction, HistoryExtractor } from '../../../src/types.js';
import { freshTmpDir, rmDir, fakeRepository, fakeSnapshot, makeExtraction, makeFakeEmbedder, makeFakeExtractor, fakeSha, FAKE_EMBEDDER_DIMENSION } from './helpers.js';
import { childSpawnArgs } from './child-script.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const childArgs = childSpawnArgs(here, repoRoot, 'refresh-child');

function countingExtractor(bySha: ReadonlyMap<string, CommitExtraction>): { extractor: HistoryExtractor; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    extractor: {
      async *extract(_snapshot, shas) {
        for (const sha of shas) {
          calls.push(sha);
          const extraction = bySha.get(sha);
          if (extraction !== undefined) yield extraction;
        }
      },
    },
  };
}

function runChildJob(job: Record<string, unknown>) {
  return new Promise<{ lines: Record<string, unknown>[]; code: number | null }>((resolve) => {
    const child = spawn(process.execPath, [...childArgs, JSON.stringify(job)]);
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('close', (code) =>
      resolve({
        code,
        // Non-JSON lines (e.g. the plain-text crash marker) are dropped
        // rather than failing the whole parse.
        lines: out
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .flatMap((l) => {
            try {
              return [JSON.parse(l) as Record<string, unknown>];
            } catch {
              return [];
            }
          }),
      }),
    );
  });
}

test('first build creates a generation, publishes CURRENT, and counts records correctly', async () => {
  const commonDir = freshTmpDir('refresh-first');
  try {
    const repository = fakeRepository(commonDir);
    const shas = [fakeSha('a'), fakeSha('b'), fakeSha('c')];
    const bySha = new Map(shas.map((sha) => [sha, makeExtraction({ sha, evidenceCount: 2 })]));
    const { extractor } = countingExtractor(bySha);
    const embedder = makeFakeEmbedder(FAKE_EMBEDDER_DIMENSION);
    const snapshot = fakeSnapshot(repository, shas, 'fp-1');

    const result = await ensureCurrentGeneration(repository, snapshot, { shas, complete: true }, { extractor, embedder });
    assert.equal(result.manifest.counts.commits, 3);
    assert.equal(result.manifest.counts.evidence, 6);
    assert.equal(result.manifest.state, 'clean');

    const layout = layoutFor(commonDir);
    assert.equal(readCurrentGenerationId(layout), result.generationId);
  } finally {
    rmDir(commonDir);
  }
});

test('an unchanged snapshot is a quick no-op: the extractor is never called again', async () => {
  const commonDir = freshTmpDir('refresh-noop');
  try {
    const repository = fakeRepository(commonDir);
    const shas = [fakeSha('a'), fakeSha('b')];
    const bySha = new Map(shas.map((sha) => [sha, makeExtraction({ sha })]));
    const { extractor, calls } = countingExtractor(bySha);
    const embedder = makeFakeEmbedder(FAKE_EMBEDDER_DIMENSION);
    const snapshot = fakeSnapshot(repository, shas, 'fp-1');

    await ensureCurrentGeneration(repository, snapshot, { shas, complete: true }, { extractor, embedder });
    assert.equal(calls.length, 2);

    calls.length = 0;
    const second = await ensureCurrentGeneration(repository, snapshot, { shas, complete: true }, { extractor, embedder });
    assert.equal(calls.length, 0, 'the quick check should short-circuit before any extraction happens');
    assert.equal(second.manifest.counts.commits, 2);
  } finally {
    rmDir(commonDir);
  }
});

test('incremental refresh only processes the newly reachable commit', async () => {
  const commonDir = freshTmpDir('refresh-incremental');
  try {
    const repository = fakeRepository(commonDir);
    const initialShas = [fakeSha('a'), fakeSha('b')];
    const newSha = fakeSha('c');
    const bySha = new Map([...initialShas, newSha].map((sha) => [sha, makeExtraction({ sha })]));
    const embedder = makeFakeEmbedder(FAKE_EMBEDDER_DIMENSION);

    const first = countingExtractor(bySha);
    await ensureCurrentGeneration(repository, fakeSnapshot(repository, initialShas, 'fp-1'), { shas: initialShas, complete: true }, { extractor: first.extractor, embedder });

    const second = countingExtractor(bySha);
    const allShas = [...initialShas, newSha];
    const result = await ensureCurrentGeneration(
      repository,
      fakeSnapshot(repository, allShas, 'fp-2'),
      { shas: allShas, complete: true },
      { extractor: second.extractor, embedder },
    );
    assert.deepEqual(second.calls, [newSha]);
    assert.equal(result.manifest.counts.commits, 3);
  } finally {
    rmDir(commonDir);
  }
});

test('reconciliation prunes now-ineligible commits only when the reachable set and snapshot are both complete', async () => {
  const commonDir = freshTmpDir('refresh-prune');
  try {
    const repository = fakeRepository(commonDir);
    const shaA = fakeSha('a');
    const shaB = fakeSha('b');
    const bySha = new Map([shaA, shaB].map((sha) => [sha, makeExtraction({ sha })]));
    const embedder = makeFakeEmbedder(FAKE_EMBEDDER_DIMENSION);

    await ensureCurrentGeneration(repository, fakeSnapshot(repository, [shaA, shaB], 'fp-1'), { shas: [shaA, shaB], complete: true }, { extractor: countingExtractor(bySha).extractor, embedder });

    // Incomplete enumeration must never prune, even though shaB looks "gone".
    const incompleteResult = await ensureCurrentGeneration(
      repository,
      fakeSnapshot(repository, [shaA], 'fp-2'),
      { shas: [shaA], complete: false },
      { extractor: countingExtractor(bySha).extractor, embedder },
    );
    assert.equal(incompleteResult.manifest.counts.commits, 2, 'an incomplete enumeration must not be treated as an empty reachable set');

    // A genuinely complete enumeration that no longer reaches shaB prunes it.
    const prunedResult = await ensureCurrentGeneration(
      repository,
      fakeSnapshot(repository, [shaA], 'fp-3'),
      { shas: [shaA], complete: true },
      { extractor: countingExtractor(bySha).extractor, embedder },
    );
    assert.equal(prunedResult.manifest.counts.commits, 1);

    const { store, lock } = await openReadOnlyStore(repository);
    const fetched = await store.fetchCommits([shaA, shaB]);
    assert.equal(fetched.size, 1);
    assert.ok(fetched.has(shaA));
    await store.close();
    lock.release();
  } finally {
    rmDir(commonDir);
  }
});

test('an interrupted first build (crash before publish) leaves CURRENT unset; the next call builds a fresh, working generation', async () => {
  const commonDir = freshTmpDir('refresh-unpublished');
  try {
    const repository = fakeRepository(commonDir);
    const shas = [fakeSha('a')];
    const bySha = new Map(shas.map((sha) => [sha, makeExtraction({ sha })]));
    const embedder = makeFakeEmbedder(FAKE_EMBEDDER_DIMENSION);
    const snapshot = fakeSnapshot(repository, shas, 'fp-1');

    const layout = layoutFor(commonDir);
    const orphanId = __testHooks.newGenerationId();
    const orphanPaths = generationPaths(layout, orphanId);
    await __testHooks.reconcile(orphanPaths, repository.objectFormat, snapshot, { shas, complete: true }, { extractor: countingExtractor(bySha).extractor, embedder }, {
      forceRetryIncomplete: false,
      batchSize: 1,
      vectorIndex: 'flat',
    });
    assert.equal(readCurrentGenerationId(layout), null, 'a reconciled-but-unpublished generation must not become CURRENT');

    const result = await ensureCurrentGeneration(repository, snapshot, { shas, complete: true }, { extractor: countingExtractor(bySha).extractor, embedder });
    assert.notEqual(result.generationId, orphanId);
    assert.equal(readCurrentGenerationId(layout), result.generationId);
    assert.equal(result.manifest.counts.commits, 1);

    const { removed } = await gc(repository);
    assert.ok(removed.some((p) => p.endsWith(orphanId)), 'gc should clean up the orphaned unpublished generation');
    assert.equal(readCurrentGenerationId(layout), result.generationId, 'gc must never remove the current generation');
  } finally {
    rmDir(commonDir);
  }
});

test('crash recovery: a real process is killed mid-batch during an incremental update, and the next run finishes the interrupted commit via the pending journal', async () => {
  const commonDir = freshTmpDir('refresh-crash-recovery');
  const layout = layoutFor(commonDir);
  const shaA = fakeSha('a');
  const shaB = fakeSha('b');
  const shaC = fakeSha('c');
  try {
    // Build #1: publish a generation containing only `a`.
    const build1 = await runChildJob({ commonDir, mode: 'ensure', shas: [shaA], fingerprint: 'fp-1', complete: true, batchSize: 1 });
    assert.ok(build1.lines.some((l) => l.event === 'done'), `build #1 should finish cleanly: ${JSON.stringify(build1.lines)}`);
    const generationId = readCurrentGenerationId(layout);
    assert.ok(generationId !== null);

    // Build #2: extend to [a, b, c] but the child process is terminated
    // (via a deliberate process.exit inside the fake extractor, the same
    // observable effect as SIGKILL — see helpers.ts) partway through
    // extracting `c`, i.e. after `b`'s batch has already been checkpointed.
    const crashRun = await runChildJob({ commonDir, mode: 'ensure', shas: [shaA, shaB, shaC], fingerprint: 'fp-2', complete: true, crashOnSha: shaC, batchSize: 1 });
    assert.notEqual(crashRun.code, 0);
    assert.ok(!crashRun.lines.some((l) => l.event === 'done'), 'the crashed run must not report success');
    assert.equal(readCurrentGenerationId(layout), generationId, 'CURRENT must still point at the original generation after the crash');

    const genPaths = generationPaths(layout, generationId!);
    const manifestAfterCrash = readManifest(genPaths.manifestFile)!;
    assert.equal(manifestAfterCrash.counts.commits, 2, 'b should have been durably checkpointed before the crash on c');
    assert.ok(fs.existsSync(genPaths.pendingFile), 'the pending marker for the in-flight batch must survive the crash');

    // Build #3: a fresh (uninstrumented) run recovers the pending commit
    // and completes the reconciliation the crashed process started.
    const build3 = await runChildJob({ commonDir, mode: 'ensure', shas: [shaA, shaB, shaC], fingerprint: 'fp-2', complete: true, batchSize: 1 });
    const done = build3.lines.find((l) => l.event === 'done') as { generationId: string; counts: { commits: number } } | undefined;
    assert.ok(done, `recovery run should finish cleanly: ${JSON.stringify(build3.lines)}`);
    assert.equal(done.generationId, generationId, 'recovery must resume the SAME generation, not fork a new one');
    assert.equal(done.counts.commits, 3);
    assert.equal(fs.existsSync(genPaths.pendingFile), false, 'the pending marker must be cleared once recovery completes');
  } finally {
    rmDir(commonDir);
  }
});

test('two real processes attempting the first build simultaneously converge on a single generation with no duplicate-record inflation', async () => {
  const commonDir = freshTmpDir('refresh-concurrent-first-build');
  const layout = layoutFor(commonDir);
  const shas = [fakeSha('x'), fakeSha('y'), fakeSha('z')];
  try {
    const job = { commonDir, mode: 'ensure' as const, shas, fingerprint: 'fp-1', complete: true, batchSize: 1 };
    const [a, b] = await Promise.all([runChildJob(job), runChildJob(job)]);

    const doneA = a.lines.find((l) => l.event === 'done') as { generationId: string; counts: { commits: number } } | undefined;
    const doneB = b.lines.find((l) => l.event === 'done') as { generationId: string; counts: { commits: number } } | undefined;
    assert.ok(doneA, `first process should finish cleanly: ${JSON.stringify(a.lines)}`);
    assert.ok(doneB, `second process should finish cleanly: ${JSON.stringify(b.lines)}`);
    assert.equal(doneA.generationId, doneB.generationId, 'both processes must converge on the same generation');
    assert.equal(doneA.counts.commits, 3);
    assert.equal(doneB.counts.commits, 3, 'the loser must see the already-published counts, not re-run and inflate them');

    const generationEntries = fs.readdirSync(layout.generationsDir);
    assert.equal(generationEntries.length, 1, 'exactly one generation directory should exist, not one per racing writer');

    const { store, lock } = await openReadOnlyStore(fakeRepository(commonDir));
    const commits = await store.fetchCommits(shas);
    assert.equal(commits.size, 3, 'no duplicate records: exactly one record per commit sha');
    await store.close();
    lock.release();
  } finally {
    rmDir(commonDir);
  }
});

test('rebuild produces a new generation while the old one stays usable; gc then removes the superseded generation', async () => {
  const commonDir = freshTmpDir('refresh-rebuild');
  const layout = layoutFor(commonDir);
  try {
    const repository = fakeRepository(commonDir);
    const embedder = makeFakeEmbedder(FAKE_EMBEDDER_DIMENSION);
    const shasV1 = [fakeSha('v1-a'), fakeSha('v1-b')];
    const bySha1 = new Map(shasV1.map((sha) => [sha, makeExtraction({ sha })]));
    const first = await ensureCurrentGeneration(repository, fakeSnapshot(repository, shasV1, 'fp-1'), { shas: shasV1, complete: true }, { extractor: countingExtractor(bySha1).extractor, embedder });
    const originalGenerationId = first.generationId;

    const shasV2 = [fakeSha('v2-a'), fakeSha('v2-b'), fakeSha('v2-c')];
    const bySha2 = new Map(shasV2.map((sha) => [sha, makeExtraction({ sha })]));
    const rebuilt = await rebuild(repository, fakeSnapshot(repository, shasV2, 'fp-2'), { shas: shasV2, complete: true }, { extractor: countingExtractor(bySha2).extractor, embedder });

    assert.notEqual(rebuilt.generationId, originalGenerationId);
    assert.equal(readCurrentGenerationId(layout), rebuilt.generationId);
    assert.equal(
      fs.existsSync(generationPaths(layout, originalGenerationId).dir),
      true,
      'the previous generation must still be on disk immediately after a rebuild',
    );

    const { removed } = await gc(repository);
    assert.ok(removed.some((p) => p.endsWith(originalGenerationId)));
    assert.equal(fs.existsSync(generationPaths(layout, originalGenerationId).dir), false);
    assert.equal(readCurrentGenerationId(layout), rebuilt.generationId, 'gc must never remove the current generation');
  } finally {
    rmDir(commonDir);
  }
});
