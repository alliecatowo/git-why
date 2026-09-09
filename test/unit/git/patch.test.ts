import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePatchSections, parseRawChanges } from '../../../src/git/patch.js';

function rawRecord(fields: string[], paths: string[]): Buffer {
  const meta = Buffer.from(`:${fields.join(' ')}`, 'utf8');
  const pathBufs = paths.map((p) => Buffer.concat([Buffer.from(p, 'utf8'), Buffer.from([0])]));
  return Buffer.concat([meta, Buffer.from([0]), ...pathBufs]);
}

test('parseRawChanges: simple modify', () => {
  const buf = rawRecord(['100644', '100644', 'a'.repeat(40), 'b'.repeat(40), 'M'], ['file.txt']);
  const entries = parseRawChanges(buf);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.changeType, 'M');
  assert.equal(entries[0]?.oldBlob, 'a'.repeat(40));
  assert.equal(entries[0]?.newBlob, 'b'.repeat(40));
  assert.equal(entries[0]?.oldPathBytes, null);
  assert.equal(entries[0]?.newPathBytes.toString('utf8'), 'file.txt');
});

test('parseRawChanges: addition has null oldMode/oldBlob', () => {
  const buf = rawRecord(['000000', '100644', '0'.repeat(40), 'b'.repeat(40), 'A'], ['new.txt']);
  const entries = parseRawChanges(buf);
  assert.equal(entries[0]?.oldMode, null);
  assert.equal(entries[0]?.oldBlob, null);
  assert.equal(entries[0]?.newMode, '100644');
});

test('parseRawChanges: deletion has null oldPath, path is the removed path', () => {
  const buf = rawRecord(['100644', '000000', 'a'.repeat(40), '0'.repeat(40), 'D'], ['gone.txt']);
  const entries = parseRawChanges(buf);
  assert.equal(entries[0]?.changeType, 'D');
  assert.equal(entries[0]?.oldPathBytes, null);
  assert.equal(entries[0]?.newPathBytes.toString('utf8'), 'gone.txt');
  assert.equal(entries[0]?.newBlob, null);
});

test('parseRawChanges: rename carries similarity and both paths', () => {
  const buf = rawRecord(['100644', '100644', 'a'.repeat(40), 'a'.repeat(40), 'R100'], ['old name.txt', 'new name.txt']);
  const entries = parseRawChanges(buf);
  assert.equal(entries[0]?.changeType, 'R');
  assert.equal(entries[0]?.similarity, 100);
  assert.equal(entries[0]?.oldPathBytes?.toString('utf8'), 'old name.txt');
  assert.equal(entries[0]?.newPathBytes.toString('utf8'), 'new name.txt');
});

test('parseRawChanges: multiple records in one buffer', () => {
  const buf = Buffer.concat([
    rawRecord(['100644', '100644', 'a'.repeat(40), 'b'.repeat(40), 'M'], ['one.txt']),
    rawRecord(['000000', '100644', '0'.repeat(40), 'c'.repeat(40), 'A'], ['two.txt']),
  ]);
  const entries = parseRawChanges(buf);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.newPathBytes.toString('utf8'), 'one.txt');
  assert.equal(entries[1]?.newPathBytes.toString('utf8'), 'two.txt');
});

function patchText(lines: string[]): Buffer {
  return Buffer.from(lines.join('\n') + '\n', 'utf8');
}

test('parsePatchSections: single hunk, tracks declared counts', () => {
  const buf = patchText([
    'diff --git a/f.txt b/f.txt',
    'index abc..def 100644',
    '--- a/f.txt',
    '+++ b/f.txt',
    '@@ -1,2 +1,2 @@',
    ' line1',
    '-line2',
    '+line2changed',
  ]);
  const sections = parsePatchSections(buf);
  assert.equal(sections.length, 1);
  assert.equal(sections[0]?.hunks.length, 1);
  const hunk = sections[0]?.hunks[0];
  assert.equal(hunk?.oldStart, 1);
  assert.equal(hunk?.oldCount, 2);
  assert.equal(hunk?.newStart, 1);
  assert.equal(hunk?.newCount, 2);
  assert.deepEqual(
    hunk?.lines.map((l) => [l.kind, l.text]),
    [
      ['context', 'line1'],
      ['remove', 'line2'],
      ['add', 'line2changed'],
    ],
  );
});

test('parsePatchSections: content line containing "diff --git" inside a hunk is not a new section', () => {
  const buf = patchText([
    'diff --git a/f.txt b/f.txt',
    'index abc..def 100644',
    '--- a/f.txt',
    '+++ b/f.txt',
    '@@ -1,1 +1,2 @@',
    '-old',
    '+diff --git a/evil b/evil',
    '+trailer',
  ]);
  const sections = parsePatchSections(buf);
  assert.equal(sections.length, 1, 'the fake "diff --git" line must stay inside the one real hunk');
  assert.equal(sections[0]?.hunks[0]?.lines.length, 3);
});

test('parsePatchSections: no trailing newline marker does not add a phantom line', () => {
  const buf = patchText([
    'diff --git a/f.txt b/f.txt',
    'index abc..def 100644',
    '--- a/f.txt',
    '+++ b/f.txt',
    '@@ -1 +1 @@',
    '-old',
    '\\ No newline at end of file',
    '+new',
    '\\ No newline at end of file',
  ]);
  const sections = parsePatchSections(buf);
  const hunk = sections[0]?.hunks[0];
  assert.equal(hunk?.lines.length, 2);
  assert.equal(hunk?.lines[0]?.noNewline, true);
  assert.equal(hunk?.lines[1]?.noNewline, true);
});

test('parsePatchSections: CRLF content preserves trailing \\r', () => {
  const buf = patchText(['diff --git a/f.txt b/f.txt', '@@ -1,1 +1,1 @@', '-line\r', '+line2\r']);
  const sections = parsePatchSections(buf);
  const hunk = sections[0]?.hunks[0];
  assert.equal(hunk?.lines[0]?.text, 'line\r');
  assert.equal(hunk?.lines[1]?.text, 'line2\r');
});

test('parsePatchSections: binary file has no hunks and is flagged', () => {
  const buf = patchText([
    'diff --git a/bin.dat b/bin.dat',
    'new file mode 100644',
    'index 0000000..0104661',
    'Binary files /dev/null and b/bin.dat differ',
  ]);
  const sections = parsePatchSections(buf);
  assert.equal(sections.length, 1);
  assert.equal(sections[0]?.binary, true);
  assert.equal(sections[0]?.hunks.length, 0);
});

test('parsePatchSections: mode-only change has no hunks', () => {
  const buf = patchText(['diff --git a/f.txt b/f.txt', 'old mode 100644', 'new mode 100755']);
  const sections = parsePatchSections(buf);
  assert.equal(sections.length, 1);
  assert.equal(sections[0]?.hunks.length, 0);
  assert.equal(sections[0]?.binary, false);
});

test('parsePatchSections: rename-only with no content change has no hunks', () => {
  const buf = patchText([
    'diff --git a/old.txt b/new.txt',
    'similarity index 100%',
    'rename from old.txt',
    'rename to new.txt',
  ]);
  const sections = parsePatchSections(buf);
  assert.equal(sections.length, 1);
  assert.equal(sections[0]?.hunks.length, 0);
});

test('parsePatchSections: multiple files in order', () => {
  const buf = patchText([
    'diff --git a/one.txt b/one.txt',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    'diff --git a/two.txt b/two.txt',
    '@@ -1 +1 @@',
    '-c',
    '+d',
  ]);
  const sections = parsePatchSections(buf);
  assert.equal(sections.length, 2);
  assert.equal(sections[0]?.index, 0);
  assert.equal(sections[1]?.index, 1);
});
