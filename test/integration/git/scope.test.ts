/**
 * Snapshot scope acceptance row (spec #6, #29): branches, tags that peel to commits,
 * remote-tracking branches and every worktree's HEAD (including detached) are in
 * scope; stash refs, reflog-only objects, notes and replace refs are not.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveRepositoryIdentity } from '../../../src/git/repository.js';
import { captureSnapshot } from '../../../src/git/snapshot.js';
import { createTestRepo } from '../../fixtures/repo.js';

test('scope includes branches, annotated tags-to-commits, remote-tracking refs and a detached worktree HEAD', async () => {
  const repo = await createTestRepo();
  const worktreeDir = await mkdtemp(join(tmpdir(), 'gitwhy-worktree-'));
  const remoteDir = await mkdtemp(join(tmpdir(), 'gitwhy-remote-'));
  try {
    await repo.writeFile('a.txt', 'a\n');
    await repo.add(['a.txt']);
    const shaMain = await repo.commit('main commit');

    await repo.gitOrThrow(['checkout', '-q', '-b', 'feature']);
    await repo.writeFile('b.txt', 'b\n');
    await repo.add(['b.txt']);
    const shaFeature = await repo.commit('feature commit');
    await repo.gitOrThrow(['checkout', '-q', 'main']);

    // Annotated tag peeling to a commit: in scope.
    await repo.gitOrThrow(['tag', '-a', 'v1', '-m', 'v1', shaMain]);
    // Tag pointing at a blob, not a commit: out of scope.
    const blobOid = (
      await repo.gitOrThrow(['hash-object', '-w', '--stdin'], {
        input: Buffer.from('blob content'),
      })
    ).stdout.trim();
    await repo.gitOrThrow(['tag', 'blob-tag', blobOid]);

    // Remote-tracking branch: clone into a bare "remote", add it, fetch.
    await rm(remoteDir, { recursive: true, force: true });
    const cloneResult = await repo.git(['clone', '-q', '--bare', repo.dir, remoteDir]);
    assert.equal(cloneResult.code, 0, cloneResult.stderr);
    await repo.gitOrThrow(['remote', 'add', 'origin', remoteDir]);
    await repo.gitOrThrow(['fetch', '-q', 'origin']);

    // Detached sibling worktree HEAD: in scope.
    await rm(worktreeDir, { recursive: true, force: true });
    await repo.gitOrThrow(['worktree', 'add', '--detach', worktreeDir, shaFeature]);

    // Out of scope: stash, notes, reflog-only commits.
    await repo.writeFile('a.txt', 'dirty\n');
    await repo.gitOrThrow(['stash', 'push', '-m', 'scoped-out stash']);
    await repo.gitOrThrow(['notes', 'add', '-m', 'a note', shaMain]);

    const repository = await resolveRepositoryIdentity(repo.dir);
    const snapshot = await captureSnapshot(repository);

    assert.equal(snapshot.complete, true);
    const names = snapshot.tips.map((t) => t.name);

    assert.ok(names.includes('refs/heads/main'), 'local branch tip missing');
    assert.ok(names.includes('refs/heads/feature'), 'local branch tip missing');
    assert.ok(names.includes('refs/tags/v1'), 'tag peeling to a commit missing');
    assert.ok(!names.includes('refs/tags/blob-tag'), 'tag peeling to a blob must be excluded');
    assert.ok(
      names.some((n) => n.startsWith('refs/remotes/origin/')),
      'remote-tracking branch missing',
    );
    assert.ok(
      names.some((n) => n.startsWith('worktree:') && n.includes(worktreeDir)),
      'detached worktree HEAD missing',
    );

    assert.ok(!names.some((n) => n.includes('stash')), 'stash ref must be excluded');
    assert.ok(snapshot.tipOids.includes(shaMain));
    assert.ok(snapshot.tipOids.includes(shaFeature));

    // Notes and reflogs are never refs under heads/remotes/tags and are never a
    // worktree HEAD, so they cannot appear via for-each-ref or worktree list at all;
    // confirm no ref name mentions "notes".
    assert.ok(!names.some((n) => n.includes('notes')), 'notes must be excluded');
  } finally {
    await repo.cleanup();
    await rm(worktreeDir, { recursive: true, force: true });
    await rm(remoteDir, { recursive: true, force: true });
  }
});
