/**
 * Path acceptance row (spec #29): spaces, quotes, tabs, newline, a leading dash, and
 * non-ASCII, with byte identity preserved through `HistoricalPath.bytesBase64` and a
 * `lossy` flag whenever the display string cannot round-trip.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGitHistoryExtractor } from '../../../src/git/extract.js';
import { FakeEmbedder } from '../../../src/embedding/fake.js';
import { resolveRepositoryIdentity } from '../../../src/git/repository.js';
import { captureSnapshot } from '../../../src/git/snapshot.js';
import { createTestRepo } from '../../fixtures/repo.js';
import type { CommitExtraction } from '../../../src/types.js';

async function extractOne(dir: string, sha: string): Promise<CommitExtraction> {
  const repository = await resolveRepositoryIdentity(dir);
  const snapshot = await captureSnapshot(repository);
  const extractor = createGitHistoryExtractor(new FakeEmbedder());
  for await (const item of extractor.extract(snapshot, [sha])) {
    return item;
  }
  throw new Error('extractor produced no result');
}

async function addAndCommitPath(name: string | Buffer, label: string) {
  const repo = await createTestRepo();
  try {
    await repo.writeFile(name, 'content\n');
    await repo.add([name]);
    const sha = await repo.commit(`add ${label}`);
    const extraction = await extractOne(repo.dir, sha);
    const change = extraction.commit.changedPaths[0];
    assert.ok(change, `expected one changed path for ${label}`);
    return { change, expectedBytes: typeof name === 'string' ? Buffer.from(name, 'utf8') : name };
  } finally {
    await repo.cleanup();
  }
}

test('path with spaces', async () => {
  const { change, expectedBytes } = await addAndCommitPath('file with spaces.txt', 'spaces');
  assert.equal(Buffer.from(change.path.bytesBase64, 'base64').equals(expectedBytes), true);
  assert.equal(change.path.lossy, false);
  assert.equal(change.path.display, 'file with spaces.txt');
});

test('path with quotes', async () => {
  const name = 'file "quoted" name.txt';
  const { change, expectedBytes } = await addAndCommitPath(name, 'quotes');
  assert.equal(Buffer.from(change.path.bytesBase64, 'base64').equals(expectedBytes), true);
  assert.equal(change.path.display, name);
});

test('path with a tab', async () => {
  const name = 'file\ttab.txt';
  const { change, expectedBytes } = await addAndCommitPath(name, 'tab');
  assert.equal(Buffer.from(change.path.bytesBase64, 'base64').equals(expectedBytes), true);
  assert.equal(change.path.display, name);
});

test('path with an embedded newline', async () => {
  const name = 'file\nnewline.txt';
  const { change, expectedBytes } = await addAndCommitPath(name, 'newline');
  assert.equal(Buffer.from(change.path.bytesBase64, 'base64').equals(expectedBytes), true);
  assert.equal(change.path.display, name);
});

test('path with a leading dash', async () => {
  const name = '-leading-dash.txt';
  const { change, expectedBytes } = await addAndCommitPath(name, 'leading dash');
  assert.equal(Buffer.from(change.path.bytesBase64, 'base64').equals(expectedBytes), true);
  assert.equal(change.path.display, name);
});

test('path with non-ASCII characters', async () => {
  const name = '日本語-emoji-🎉.txt';
  const { change, expectedBytes } = await addAndCommitPath(name, 'non-ascii');
  assert.equal(Buffer.from(change.path.bytesBase64, 'base64').equals(expectedBytes), true);
  assert.equal(change.path.display, name);
  assert.equal(change.path.lossy, false);
});

test('non-UTF-8 byte path identity, where the platform permits creating one', async () => {
  // Invalid UTF-8 byte sequence (lone continuation bytes). Some filesystems (notably
  // macOS/APFS) require valid UTF-8 filenames and will refuse to create this file; in
  // that case the platform does not permit the test, and it is skipped with a clear
  // reason rather than silently passing or failing.
  const weirdName = Buffer.concat([
    Buffer.from('bad-'),
    Buffer.from([0xff, 0xfe, 0x80]),
    Buffer.from('.txt'),
  ]);
  const repo = await createTestRepo();
  try {
    try {
      await repo.writeFile(weirdName, 'content\n');
    } catch (error) {
      console.log(
        `SKIP: platform filesystem rejected a non-UTF-8 filename: ${(error as Error).message}`,
      );
      return;
    }
    await repo.add([weirdName]);
    const sha = await repo.commit('add non-utf8 path');
    const extraction = await extractOne(repo.dir, sha);
    const change = extraction.commit.changedPaths[0];
    assert.ok(change);
    const decoded = Buffer.from(change.path.bytesBase64, 'base64');
    assert.equal(
      decoded.equals(weirdName),
      true,
      'raw bytes must be preserved exactly regardless of display lossiness',
    );
    assert.equal(
      change.path.lossy,
      true,
      'a non-UTF-8 path must not round-trip through the display string',
    );
  } finally {
    await repo.cleanup();
  }
});
