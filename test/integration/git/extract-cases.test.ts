/**
 * Integration coverage for the commit-case table in docs/spec.md #7, run against real
 * repositories built by `test/fixtures/repo.ts`: root, deletion, rename-only,
 * mode-only, binary, CRLF, no-trailing-newline, and merge metadata.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGitHistoryExtractor } from '../../../src/git/extract.js';
import { FakeEmbedder } from '../../../src/embedding/fake.js';
import { resolveRepositoryIdentity } from '../../../src/git/repository.js';
import { captureSnapshot } from '../../../src/git/snapshot.js';
import { createTestRepo } from '../../fixtures/repo.js';
import type { CommitExtraction } from '../../../src/types.js';

async function extractAll(
  dir: string,
  shas: readonly string[],
): Promise<Map<string, CommitExtraction>> {
  const repository = await resolveRepositoryIdentity(dir);
  const snapshot = await captureSnapshot(repository);
  const extractor = createGitHistoryExtractor(new FakeEmbedder());
  const out = new Map<string, CommitExtraction>();
  for await (const item of extractor.extract(snapshot, shas)) {
    out.set(item.commit.sha, item);
  }
  return out;
}

test('root commit: zero parents, diffs against the empty tree, no hard-coded hash', async () => {
  const repo = await createTestRepo();
  try {
    await repo.writeFile('a.txt', 'hello\n');
    await repo.add(['a.txt']);
    const sha = await repo.commit('root commit');

    const results = await extractAll(repo.dir, [sha]);
    const extraction = results.get(sha);
    assert.ok(extraction);
    assert.deepEqual(extraction.commit.parents, []);
    assert.equal(extraction.commit.changedPaths.length, 1);
    assert.equal(extraction.commit.changedPaths[0]?.changeType, 'A');
    assert.equal(extraction.commit.changedPaths[0]?.path.display, 'a.txt');
    assert.equal(extraction.commit.coverage.complete, true);
    const hunkEvidence = extraction.evidence.find((e) => e.kind === 'hunk');
    assert.ok(
      hunkEvidence,
      'root commit should still produce hunk evidence against the empty tree',
    );
    assert.match(hunkEvidence.sourceExcerpt, /\+hello/);
  } finally {
    await repo.cleanup();
  }
});

test('deletion: removed code and historical path retained', async () => {
  const repo = await createTestRepo();
  try {
    await repo.writeFile('gone.txt', 'line one\nline two\n');
    await repo.add(['gone.txt']);
    await repo.commit('add file');
    await repo.rm(['gone.txt']);
    const sha = await repo.commit('delete file');

    const results = await extractAll(repo.dir, [sha]);
    const extraction = results.get(sha);
    assert.ok(extraction);
    const change = extraction.commit.changedPaths[0];
    assert.equal(change?.changeType, 'D');
    assert.equal(change?.path.display, 'gone.txt');
    assert.equal(change?.oldPath, null);
    const hunk = extraction.evidence.find((e) => e.kind === 'hunk');
    assert.ok(hunk);
    assert.match(hunk.sourceExcerpt, /-line one/);
    assert.match(hunk.sourceExcerpt, /-line two/);
  } finally {
    await repo.cleanup();
  }
});

test('rename-only: no textual hunk still yields file_change evidence with both paths', async () => {
  const repo = await createTestRepo();
  try {
    await repo.writeFile('old-name.txt', 'unchanged content\n');
    await repo.add(['old-name.txt']);
    await repo.commit('add file');
    await repo.mv('old-name.txt', 'new-name.txt');
    const sha = await repo.commit('rename file');

    const results = await extractAll(repo.dir, [sha]);
    const extraction = results.get(sha);
    assert.ok(extraction);
    const change = extraction.commit.changedPaths[0];
    assert.equal(change?.changeType, 'R');
    assert.equal(change?.similarity, 100);
    assert.equal(change?.path.display, 'new-name.txt');
    assert.equal(change?.oldPath?.display, 'old-name.txt');

    assert.equal(extraction.evidence.length, 1);
    assert.equal(extraction.evidence[0]?.kind, 'file_change');
    assert.equal(extraction.evidence[0]?.hunkOrdinal, null);
  } finally {
    await repo.cleanup();
  }
});

test('mode-only change: summary and file-change metadata, no fabricated patch', async () => {
  const repo = await createTestRepo();
  try {
    await repo.writeFile('script.sh', '#!/bin/sh\necho hi\n');
    await repo.add(['script.sh']);
    await repo.commit('add script');
    await repo.gitOrThrow(['update-index', '--chmod=+x', 'script.sh']);
    const sha = await repo.commit('make executable');

    const results = await extractAll(repo.dir, [sha]);
    const extraction = results.get(sha);
    assert.ok(extraction);
    const change = extraction.commit.changedPaths[0];
    assert.equal(change?.changeType, 'M');
    assert.equal(change?.oldMode, '100644');
    assert.equal(change?.newMode, '100755');
    assert.equal(extraction.evidence.length, 1);
    assert.equal(extraction.evidence[0]?.kind, 'file_change');
    assert.equal(extraction.evidence[0]?.sourceExcerpt, '');
  } finally {
    await repo.cleanup();
  }
});

test('binary change: coverage reason "binary", no fabricated textual patch', async () => {
  const repo = await createTestRepo();
  try {
    await repo.writeFile('bin.dat', Buffer.from([0, 1, 2, 3, 255, 254]));
    await repo.add(['bin.dat']);
    const sha = await repo.commit('add binary');

    const results = await extractAll(repo.dir, [sha]);
    const extraction = results.get(sha);
    assert.ok(extraction);
    assert.equal(extraction.evidence.length, 1);
    const evidence = extraction.evidence[0];
    assert.equal(evidence?.kind, 'file_change');
    assert.equal(evidence?.sourceExcerpt, '');
    assert.ok(evidence?.coverage.reasons.includes('binary'));
    assert.ok(extraction.commit.coverage.reasons.includes('binary'));
  } finally {
    await repo.cleanup();
  }
});

test('CRLF content is preserved byte-for-byte in evidence', async () => {
  const repo = await createTestRepo();
  try {
    await repo.writeFile('crlf.txt', Buffer.from('line1\r\nline2\r\n', 'utf8'));
    await repo.add(['crlf.txt']);
    await repo.commit('add crlf');
    await repo.writeFile('crlf.txt', Buffer.from('line1\r\nline2changed\r\n', 'utf8'));
    await repo.add(['crlf.txt']);
    const sha = await repo.commit('change crlf');

    const results = await extractAll(repo.dir, [sha]);
    const extraction = results.get(sha);
    assert.ok(extraction);
    const hunk = extraction.evidence.find((e) => e.kind === 'hunk');
    assert.ok(hunk);
    assert.ok(hunk.sourceExcerpt.includes('-line2\r'));
    assert.ok(hunk.sourceExcerpt.includes('+line2changed\r'));
  } finally {
    await repo.cleanup();
  }
});

test('no trailing newline: exact content preserved, no phantom line added', async () => {
  const repo = await createTestRepo();
  try {
    await repo.writeFile('noeol.txt', Buffer.from('noeol', 'utf8'));
    await repo.add(['noeol.txt']);
    await repo.commit('add noeol');
    await repo.writeFile('noeol.txt', Buffer.from('noeolchanged', 'utf8'));
    await repo.add(['noeol.txt']);
    const sha = await repo.commit('change noeol');

    const results = await extractAll(repo.dir, [sha]);
    const extraction = results.get(sha);
    assert.ok(extraction);
    const hunk = extraction.evidence.find((e) => e.kind === 'hunk');
    assert.ok(hunk);
    assert.equal(hunk.oldCount, 1);
    assert.equal(hunk.newCount, 1);
    assert.ok(hunk.sourceExcerpt.includes('-noeol'));
    assert.ok(hunk.sourceExcerpt.includes('+noeolchanged'));
  } finally {
    await repo.cleanup();
  }
});

test('merge commit: all parent OIDs, first-parent changed paths, no hunk evidence', async () => {
  const repo = await createTestRepo();
  try {
    await repo.writeFile('base.txt', 'base\n');
    await repo.add(['base.txt']);
    await repo.commit('base commit');
    const mainBranch = await repo.currentBranch();

    await repo.gitOrThrow(['checkout', '-q', '-b', 'feature']);
    await repo.writeFile('feature.txt', 'feature\n');
    await repo.add(['feature.txt']);
    await repo.commit('feature commit');

    await repo.gitOrThrow(['checkout', '-q', mainBranch]);
    await repo.writeFile('main-side.txt', 'main side\n');
    await repo.add(['main-side.txt']);
    await repo.commit('main side commit');

    const mergeResult = await repo.git([
      'merge',
      '-q',
      '--no-ff',
      'feature',
      '-m',
      'merge feature',
    ]);
    assert.equal(mergeResult.code, 0, mergeResult.stderr);
    const mergeSha = await repo.head();
    const parentsResult = await repo.gitOrThrow(['log', '-1', '--format=%P', mergeSha]);
    const parents = parentsResult.stdout.trim().split(' ');
    assert.equal(parents.length, 2);

    const results = await extractAll(repo.dir, [mergeSha]);
    const extraction = results.get(mergeSha);
    assert.ok(extraction);
    assert.deepEqual([...extraction.commit.parents].sort(), [...parents].sort());
    assert.equal(extraction.evidence.length, 0, 'no merge diff hunks in V1');
    assert.ok(extraction.commit.coverage.reasons.includes('merge_hunks_omitted'));
    assert.equal(extraction.commit.coverage.complete, false);
    // Changed paths relative to the first parent (main side) only: feature.txt, not main-side.txt.
    const paths = extraction.commit.changedPaths.map((c) => c.path.display).sort();
    assert.deepEqual(paths, ['feature.txt']);
  } finally {
    await repo.cleanup();
  }
});

test('submodule pointer: gitlink OIDs kept as metadata, no submodule content indexed', async () => {
  const repo = await createTestRepo();
  try {
    await repo.writeFile('placeholder.txt', 'x\n');
    await repo.add(['placeholder.txt']);
    await repo.commit('init');
    const fakeSubOid = '1'.repeat(40);
    await repo.gitOrThrow(['update-index', '--add', '--cacheinfo', `160000,${fakeSubOid},sub`]);
    const sha = await repo.commit('add submodule pointer');

    const results = await extractAll(repo.dir, [sha]);
    const extraction = results.get(sha);
    assert.ok(extraction);
    const change = extraction.commit.changedPaths.find((c) => c.path.display === 'sub');
    assert.ok(change);
    assert.equal(change.newMode, '160000');
    assert.equal(change.newBlob, fakeSubOid);
    const evidence = extraction.evidence.find((e) => e.path.display === 'sub');
    assert.ok(evidence);
    assert.equal(evidence.kind, 'file_change');
  } finally {
    await repo.cleanup();
  }
});
