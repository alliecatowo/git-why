/**
 * Shallow/partial acceptance row (spec #7, #29): a missing parent at the shallow
 * boundary is never treated as a root; message/path evidence still available from
 * the commit object is retained; no implicit fetch happens while reading it.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createGitHistoryExtractor } from '../../../src/git/extract.js';
import { FakeEmbedder } from '../../../src/embedding/fake.js';
import { resolveRepositoryIdentity } from '../../../src/git/repository.js';
import { captureSnapshot } from '../../../src/git/snapshot.js';
import { enumerateReachable } from '../../../src/git/reachable.js';
import { createTestRepo } from '../../fixtures/repo.js';

test('shallow clone: boundary commit keeps evidence, is not treated as root, coverage flags it', async () => {
  const source = await createTestRepo();
  const cloneDir = await mkdtemp(join(tmpdir(), 'gitwhy-shallow-'));
  try {
    const shas: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      await source.writeFile('f.txt', `line ${i}\n`);
      await source.add(['f.txt']);
      shas.push(await source.commit(`commit ${i}`));
    }

    await rm(cloneDir, { recursive: true, force: true });
    const clone = await source.git([
      'clone',
      '-q',
      '--depth=2',
      '--no-local',
      `file://${source.dir}`,
      cloneDir,
    ]);
    assert.equal(clone.code, 0, clone.stderr);

    const repository = await resolveRepositoryIdentity(cloneDir);
    assert.equal(repository.isShallow, true);
    const snapshot = await captureSnapshot(repository);
    assert.ok(
      snapshot.shallowBoundary.length > 0,
      'shallow boundary must list real OIDs, not just a boolean',
    );

    const boundaryOid = snapshot.shallowBoundary[0] as string;
    const reachable = await enumerateReachable(repository, snapshot.tipOids);
    assert.ok(
      reachable.length > 0,
      'a failed/interrupted enumeration must throw, never silently return empty',
    );
    assert.ok(reachable.includes(boundaryOid));

    const extractor = createGitHistoryExtractor(new FakeEmbedder());
    const results = [];
    for await (const item of extractor.extract(snapshot, [boundaryOid])) results.push(item);
    assert.equal(results.length, 1);
    const extraction = results[0];
    assert.ok(extraction);

    // Missing ancestor must not become a root: the commit object still lists a
    // parent, so `parents` is non-empty even though that parent is unavailable.
    assert.ok(
      extraction.commit.parents.length > 0,
      'a shallow boundary commit must not be reported as a root',
    );
    assert.equal(
      extraction.commit.subject.length > 0,
      true,
      'message evidence must still be retained',
    );
    assert.ok(extraction.commit.coverage.reasons.includes('shallow_boundary'));
    assert.equal(extraction.commit.coverage.complete, false);
    assert.equal(
      extraction.evidence.length,
      0,
      'no diff evidence is obtainable across the shallow boundary',
    );
  } finally {
    await source.cleanup();
    await rm(cloneDir, { recursive: true, force: true });
  }
});
