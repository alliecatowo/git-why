import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  JsonLineageStore,
  buildIntervals,
  lineageEventFromExtraction,
  writeLineageEvents,
  type LineageEvent,
} from '../../../src/history/lineage.js';
import type { CommitExtraction } from '../../../src/types.js';

const event = (
  sha: string,
  parents: string[],
  additions: string[] = [],
  removals: string[] = [],
): LineageEvent => ({
  sha,
  parents,
  committerTime: 9_999_999 - sha.charCodeAt(0),
  subject: sha,
  paths: ['src', 'src/auth.ts'],
  additions,
  removals,
  ranges: [],
});

test('interval endpoints use DAG ancestry, never deliberately scrambled timestamps', () => {
  const intervals = buildIntervals([
    event('c', ['b'], [], ['sessiontoken']),
    event('a', [], ['sessiontoken']),
    event('b', ['a'], ['sessiontoken']),
  ]);
  assert.deepEqual(intervals.tokens.get('sessiontoken'), {
    key: 'sessiontoken',
    kind: 'token',
    firstAddedSha: 'a',
    lastAddedSha: 'b',
    firstRemovedSha: 'c',
    lastRemovedSha: 'c',
    chain: ['a', 'b', 'c'],
  });
});

test('sidecar replaces an extraction by SHA and links path siblings and token endpoints', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-why-lineage-'));
  try {
    const file = path.join(dir, 'lineage.json');
    writeLineageEvents(file, [event('a', [], ['cookie']), event('b', ['a'], ['cookie'])]);
    writeLineageEvents(file, [event('b', ['a'], [], ['cookie'])]);
    const store = new JsonLineageStore(file);
    assert.equal((await store.lookupToken('cookie'))?.lastAddedSha, 'a');
    assert.equal((await store.lookupToken('cookie'))?.lastRemovedSha, 'b');
    assert.deepEqual([...(await store.linkedCommits('a', 1))].sort(), [['b', 1]]);
    assert.ok((await store.diskBytes()) > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('extraction event obtains code identifiers only from added and removed diff lines', () => {
  const extraction = {
    commit: {
      sha: 'a',
      parents: [],
      committerTime: 3,
      subject: 'add session',
      changedPaths: [{ path: { display: 'src/session.ts' }, oldPath: null }],
    },
    evidence: [
      {
        kind: 'hunk',
        path: { display: 'src/session.ts' },
        oldStart: 1,
        newStart: 1,
        oldCount: 1,
        newCount: 1,
        sourceExcerpt: '-oldCookie\n+newSessionToken\n context',
      },
    ],
  } as unknown as CommitExtraction;
  const result = lineageEventFromExtraction(extraction);
  assert.deepEqual(result.additions, ['newsessiontoken']);
  assert.deepEqual(result.removals, ['oldcookie']);
  assert.deepEqual(result.paths, ['src', 'src/session.ts']);
});

// The lineage table is large — 35 MB of JSON on curl, about two seconds to
// read and index. `Backend.search()` constructs a store on EVERY query,
// before it knows whether anything will ask it a question, and only ordinal
// and timeline constraints ever do. An eager constructor therefore charged
// every ordinary `git why "..."` two seconds for a structure it never touched:
// 63% of the query's total time on curl.
//
// These pin the two halves of the fix. Constructing must not read; the first
// lookup must.
test('constructing a store does not read the file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-why-lineage-lazy-'));
  try {
    const file = path.join(dir, 'lineage.json');
    writeLineageEvents(file, [event('a', [], ['cookie'])]);
    // A store over a file that cannot be read must still construct. If the
    // constructor touches the file this throws, which is exactly the
    // regression being guarded against.
    assert.doesNotThrow(() => new JsonLineageStore(path.join(dir, 'does-not-exist.json')));
    assert.doesNotThrow(() => new JsonLineageStore(file));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the file is read on first lookup and not re-read afterwards', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-why-lineage-once-'));
  try {
    const file = path.join(dir, 'lineage.json');
    writeLineageEvents(file, [event('a', [], ['cookie']), event('b', ['a'], ['cookie'])]);
    const store = new JsonLineageStore(file);

    assert.equal((await store.lookupToken('cookie'))?.firstAddedSha, 'a');

    // Deleting the file after the first lookup must not affect later ones: if
    // a second lookup re-read from disk, this would start returning null and
    // every query would be paying the parse again.
    fs.rmSync(file);
    assert.equal((await store.lookupToken('cookie'))?.firstAddedSha, 'a');
    assert.deepEqual([...(await store.linkedCommits('a', 1))].sort(), [['b', 1]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
