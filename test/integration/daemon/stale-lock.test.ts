/**
 * Regression: a daemon that finds its warm index stale after a commit must not
 * keep holding the shared lock, or the direct fallback's exclusive refresh
 * blocks until --lock-timeout and fails with INDEX_BUSY.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { enumerateReachable } from '../../../src/git/reachable.js';
import { resolveRepositoryIdentity } from '../../../src/git/repository.js';
import { captureSnapshot } from '../../../src/git/snapshot.js';
import { RuntimeManager } from '../../../src/daemon/runtime.js';
import { ensureCurrentGeneration } from '../../../src/index/refresh.js';
import { layoutFor } from '../../../src/index/layout.js';
import { acquireExclusive } from '../../../src/index/lock.js';
import { createTestRepo } from '../../fixtures/repo.js';
import { makeExtraction, makeFakeEmbedder } from '../index/helpers.js';
import type { HistoryExtractor } from '../../../src/types.js';

test('a stale daemon runtime releases its shared lock so a refresh can take the exclusive lock', async () => {
  const repo = await createTestRepo();
  const manager = new RuntimeManager({ idleTtlMs: 60_000 });
  try {
    await repo.writeFile('a.txt', 'one\n');
    await repo.add(['a.txt']);
    await repo.commit('first');

    const identity = await resolveRepositoryIdentity(repo.dir);
    const extractor: HistoryExtractor = {
      async *extract(_s, shas) {
        for (const sha of shas) yield makeExtraction({ sha });
      },
    };
    const embedder = makeFakeEmbedder();
    const build = async () => {
      const snapshot = await captureSnapshot(identity);
      const shas = await enumerateReachable(identity, snapshot.tipOids);
      const reachable = { shas, complete: true };
      await ensureCurrentGeneration(identity, snapshot, reachable, { extractor, embedder });
    };
    await build();

    const fresh = await manager.acquire(repo.dir, { needsEmbedder: false });
    assert.equal(fresh.stale, false);
    fresh.release();

    await repo.writeFile('a.txt', 'two\n');
    await repo.add(['a.txt']);
    await repo.commit('second');

    const stale = await manager.acquire(repo.dir, { needsEmbedder: false });
    assert.equal(stale.stale, true);
    stale.release();

    // Would time out (INDEX_BUSY) if the daemon still held its shared lock.
    const exclusive = await acquireExclusive(layoutFor(identity.commonDir).repositoryLockFile, 3);
    exclusive.release();
  } finally {
    await manager.close();
    await repo.cleanup();
  }
});
