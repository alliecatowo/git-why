import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  layoutFor,
  ensureScaffolding,
  generationPaths,
  stagingPaths,
  isValidGenerationId,
  publishCurrentGenerationId,
  readCurrentGenerationId,
  assertSafeToRecursivelyDelete,
  recursivelyRemove,
} from '../../../src/index/layout.js';

function freshTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `git-why-${prefix}-`));
}

function rmDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('isValidGenerationId rejects path-traversal and empty ids', () => {
  assert.equal(isValidGenerationId('g-abc123'), true);
  assert.equal(isValidGenerationId('..'), false);
  assert.equal(isValidGenerationId('.'), false);
  assert.equal(isValidGenerationId('../escape'), false);
  assert.equal(isValidGenerationId('a/b'), false);
  assert.equal(isValidGenerationId(''), false);
});

test('publishCurrentGenerationId then readCurrentGenerationId round-trips atomically', () => {
  const commonDir = freshTmpDir('layout');
  try {
    const layout = layoutFor(commonDir);
    ensureScaffolding(layout);
    assert.equal(readCurrentGenerationId(layout), null);
    publishCurrentGenerationId(layout, 'g-1');
    assert.equal(readCurrentGenerationId(layout), 'g-1');
    publishCurrentGenerationId(layout, 'g-2');
    assert.equal(readCurrentGenerationId(layout), 'g-2');
  } finally {
    rmDir(commonDir);
  }
});

test('assertSafeToRecursivelyDelete rejects a path outside the owned generations/staging roots', () => {
  const commonDir = freshTmpDir('layout');
  try {
    const layout = layoutFor(commonDir);
    ensureScaffolding(layout);
    assert.throws(
      () => assertSafeToRecursivelyDelete(layout, commonDir),
      /outside generations\/staging/,
    );
    assert.throws(
      () => assertSafeToRecursivelyDelete(layout, path.dirname(commonDir)),
      /outside generations\/staging/,
    );
  } finally {
    rmDir(commonDir);
  }
});

test('assertSafeToRecursivelyDelete rejects a symlinked generation directory', () => {
  const commonDir = freshTmpDir('layout');
  const outsideTarget = freshTmpDir('layout-outside');
  try {
    const layout = layoutFor(commonDir);
    ensureScaffolding(layout);
    const gp = generationPaths(layout, 'g-evil');
    fs.symlinkSync(outsideTarget, gp.dir);
    assert.throws(() => assertSafeToRecursivelyDelete(layout, gp.dir), /symlinked/);
    // The outside target must survive even though we asked to delete the symlink path.
    assert.equal(fs.existsSync(outsideTarget), true);
  } finally {
    rmDir(commonDir);
    rmDir(outsideTarget);
  }
});

test('recursivelyRemove deletes a real, owned generation directory but never the common dir', () => {
  const commonDir = freshTmpDir('layout');
  try {
    const layout = layoutFor(commonDir);
    ensureScaffolding(layout);
    const gp = generationPaths(layout, 'g-real');
    fs.mkdirSync(gp.dir, { recursive: true });
    fs.writeFileSync(path.join(gp.dir, 'marker'), 'x');
    recursivelyRemove(layout, gp.dir);
    assert.equal(fs.existsSync(gp.dir), false);
    assert.equal(fs.existsSync(commonDir), true);

    const sp = stagingPaths(layout, 'staging-real');
    fs.mkdirSync(sp.dir, { recursive: true });
    recursivelyRemove(layout, sp.dir);
    assert.equal(fs.existsSync(sp.dir), false);
  } finally {
    rmDir(commonDir);
  }
});
