/**
 * Git object format acceptance row (spec #29): SHA-1 and SHA-256 fixtures, no
 * hard-coded hash length or empty-tree object ID. The SHA-256 case is skipped with a
 * clear message if the installed Git refuses `--object-format=sha256`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGitHistoryExtractor } from '../../../src/git/extract.js';
import { resolveRepositoryIdentity } from '../../../src/git/repository.js';
import { captureSnapshot } from '../../../src/git/snapshot.js';
import { createTestRepo, supportsObjectFormat } from '../../fixtures/repo.js';

test('SHA-1 repository: object format detected, 40-char OIDs', async () => {
  const repo = await createTestRepo({ objectFormat: 'sha1' });
  try {
    await repo.writeFile('a.txt', 'hello\n');
    await repo.add(['a.txt']);
    const sha = await repo.commit('root');

    const repository = await resolveRepositoryIdentity(repo.dir);
    assert.equal(repository.objectFormat, 'sha1');
    assert.equal(sha.length, 40);

    const snapshot = await captureSnapshot(repository);
    const extractor = createGitHistoryExtractor();
    let count = 0;
    for await (const item of extractor.extract(snapshot, [sha])) {
      count += 1;
      assert.equal(item.commit.sha, sha);
    }
    assert.equal(count, 1);
  } finally {
    await repo.cleanup();
  }
});

test('SHA-256 repository: object format detected, 64-char OIDs, empty tree resolved dynamically', async () => {
  if (!(await supportsObjectFormat('sha256'))) {
    // eslint-disable-next-line no-console
    console.log('SKIP: installed Git does not support --object-format=sha256 on this machine');
    return;
  }
  const repo = await createTestRepo({ objectFormat: 'sha256' });
  try {
    await repo.writeFile('a.txt', 'hello\n');
    await repo.add(['a.txt']);
    const sha = await repo.commit('root');

    const repository = await resolveRepositoryIdentity(repo.dir);
    assert.equal(repository.objectFormat, 'sha256');
    assert.equal(sha.length, 64);

    const snapshot = await captureSnapshot(repository);
    const extractor = createGitHistoryExtractor();
    const results = [];
    for await (const item of extractor.extract(snapshot, [sha])) results.push(item);
    assert.equal(results.length, 1);
    assert.deepEqual(results[0]?.commit.parents, []);
    assert.equal(results[0]?.commit.changedPaths[0]?.changeType, 'A');
    const hunk = results[0]?.evidence.find((e) => e.kind === 'hunk');
    assert.ok(hunk, 'root commit in a SHA-256 repo must still diff against a correctly resolved empty tree');
  } finally {
    await repo.cleanup();
  }
});
