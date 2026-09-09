import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readManifest, writeManifestAtomic, manifestPolicyIsCompatible, currentPolicyIdentities, type IndexManifest } from '../../../src/index/manifest.js';
import { GitWhyError } from '../../../src/types.js';

function freshTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'git-why-manifest-'));
}

function sampleManifest(overrides: Partial<IndexManifest> = {}): IndexManifest {
  return {
    ...currentPolicyIdentities(),
    embeddingModelId: 'fake',
    embeddingModelRevision: '1',
    embeddingFingerprint: 'fp',
    objectFormat: 'sha1',
    snapshotFingerprint: 'snap-1',
    databaseFormatCompatibility: 'git-why-zvec-schema-v1',
    counts: { commits: 0, evidence: 0 },
    omissions: { excludedFiles: 0, unavailableFiles: 0, failedFiles: 0, reasons: [] },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    state: 'clean',
    generationId: 'g-1',
    ...overrides,
  };
}

test('readManifest returns null when the file does not exist', () => {
  const dir = freshTmpDir();
  try {
    assert.equal(readManifest(path.join(dir, 'manifest.json')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeManifestAtomic then readManifest round-trips exactly', () => {
  const dir = freshTmpDir();
  try {
    const file = path.join(dir, 'nested', 'manifest.json');
    const manifest = sampleManifest({ counts: { commits: 3, evidence: 9 } });
    writeManifestAtomic(file, manifest);
    const roundTripped = readManifest(file);
    assert.deepEqual(roundTripped, manifest);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeManifestAtomic leaves no temp files behind', () => {
  const dir = freshTmpDir();
  try {
    const file = path.join(dir, 'manifest.json');
    writeManifestAtomic(file, sampleManifest());
    const entries = fs.readdirSync(dir);
    assert.deepEqual(entries, ['manifest.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readManifest throws INDEX_CORRUPT on invalid JSON', () => {
  const dir = freshTmpDir();
  try {
    const file = path.join(dir, 'manifest.json');
    fs.writeFileSync(file, '{ not json');
    assert.throws(() => readManifest(file), (err: unknown) => err instanceof GitWhyError && err.code === 'INDEX_CORRUPT');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readManifest throws INDEX_CORRUPT when a required field is missing', () => {
  const dir = freshTmpDir();
  try {
    const file = path.join(dir, 'manifest.json');
    const { generationId: _drop, ...incomplete } = sampleManifest();
    fs.writeFileSync(file, JSON.stringify(incomplete));
    assert.throws(() => readManifest(file), (err: unknown) => err instanceof GitWhyError && err.code === 'INDEX_CORRUPT');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('manifestPolicyIsCompatible detects a version drift', () => {
  assert.equal(manifestPolicyIsCompatible(sampleManifest()), true);
  assert.equal(manifestPolicyIsCompatible(sampleManifest({ recordSchemaVersion: 999 })), false);
  assert.equal(manifestPolicyIsCompatible(sampleManifest({ rankingVersion: 999 })), false);
});
