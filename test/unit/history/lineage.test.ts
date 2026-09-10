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
