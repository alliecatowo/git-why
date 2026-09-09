import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDocId, commitDocId, DOC_ID_HEX_LENGTH, evidenceDocId } from '../../../src/history/ids.js';

test('commitDocId is deterministic and full-length hex', () => {
  const a = commitDocId('deadbeef');
  const b = commitDocId('deadbeef');
  assert.equal(a, b);
  assert.equal(a.length, DOC_ID_HEX_LENGTH);
  assert.match(a, /^[0-9a-f]+$/);
});

test('commitDocId differs for different commits', () => {
  assert.notEqual(commitDocId('sha-one'), commitDocId('sha-two'));
});

test('evidenceDocId differs by hunk ordinal', () => {
  const base = { sha: 's', parentSha: 'p', pathBytesBase64: Buffer.from('src/a.ts').toString('base64') };
  const a = evidenceDocId({ ...base, hunkOrdinal: 0, sliceOrdinal: 0 });
  const b = evidenceDocId({ ...base, hunkOrdinal: 1, sliceOrdinal: 0 });
  assert.notEqual(a, b);
});

test('evidenceDocId differs by slice ordinal', () => {
  const base = { sha: 's', parentSha: 'p', pathBytesBase64: Buffer.from('src/a.ts').toString('base64') };
  const a = evidenceDocId({ ...base, hunkOrdinal: 0, sliceOrdinal: 0 });
  const b = evidenceDocId({ ...base, hunkOrdinal: 0, sliceOrdinal: 1 });
  assert.notEqual(a, b);
});

test('evidenceDocId differs by path bytes even with identical other fields', () => {
  const a = evidenceDocId({
    sha: 's',
    parentSha: 'p',
    pathBytesBase64: Buffer.from('src/a.ts').toString('base64'),
    hunkOrdinal: 0,
    sliceOrdinal: 0,
  });
  const b = evidenceDocId({
    sha: 's',
    parentSha: 'p',
    pathBytesBase64: Buffer.from('src/b.ts').toString('base64'),
    hunkOrdinal: 0,
    sliceOrdinal: 0,
  });
  assert.notEqual(a, b);
});

test('null vs present parent OID never collide (presence-framed, not delimiter-joined)', () => {
  const withNullParent = evidenceDocId({
    sha: 's',
    parentSha: null,
    pathBytesBase64: Buffer.from('x').toString('base64'),
    hunkOrdinal: null,
    sliceOrdinal: 0,
  });
  const withEmptyStringParent = evidenceDocId({
    sha: 's',
    parentSha: '',
    pathBytesBase64: Buffer.from('x').toString('base64'),
    hunkOrdinal: null,
    sliceOrdinal: 0,
  });
  assert.notEqual(withNullParent, withEmptyStringParent);
});

test('commit and evidence record types never collide even with matching-looking fields', () => {
  const commitId = commitDocId('shared-oid');
  const evidenceId = evidenceDocId({
    sha: 'shared-oid',
    parentSha: null,
    pathBytesBase64: Buffer.from('').toString('base64'),
    hunkOrdinal: null,
    sliceOrdinal: 0,
  });
  assert.notEqual(commitId, evidenceId);
});

test('buildDocId is easy to shorten: a shorter hexLength is a prefix of the full digest', () => {
  const input = {
    recordType: 'evidence' as const,
    commitOid: 'sha',
    parentOid: null,
    pathBytes: Buffer.from('src/x.ts'),
    hunkOrdinal: 2,
    sliceOrdinal: 0,
  };
  const full = buildDocId(input);
  const short = buildDocId(input, 16);
  assert.equal(full.slice(0, 16), short);
  assert.equal(short.length, 16);
});

test('buildDocId rejects an out-of-range hexLength', () => {
  const input = {
    recordType: 'commit' as const,
    commitOid: 'sha',
    parentOid: null,
    pathBytes: null,
    hunkOrdinal: null,
    sliceOrdinal: null,
  };
  assert.throws(() => buildDocId(input, 0));
  assert.throws(() => buildDocId(input, 65));
});
