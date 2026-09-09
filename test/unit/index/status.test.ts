import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeIndexStatus } from '../../../src/index/status.js';
import { layoutFor, ensureScaffolding, generationPaths, publishCurrentGenerationId } from '../../../src/index/layout.js';
import { writeManifestAtomic, currentPolicyIdentities, type IndexManifest } from '../../../src/index/manifest.js';
import { writePendingBatch } from '../../../src/index/journal.js';

function freshTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'git-why-status-'));
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
    counts: { commits: 2, evidence: 5 },
    omissions: { excludedFiles: 0, unavailableFiles: 0, failedFiles: 0, reasons: [] },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    state: 'clean',
    generationId: 'g-1',
    ...overrides,
  };
}

test('computeIndexStatus reports "missing" when there is no CURRENT generation', () => {
  const commonDir = freshTmpDir();
  try {
    const status = computeIndexStatus({ commonDir, objectFormat: 'sha1', shallow: false, currentSnapshotFingerprint: null, refsChanged: false });
    assert.equal(status.state, 'missing');
    assert.equal(status.generation, null);
  } finally {
    fs.rmSync(commonDir, { recursive: true, force: true });
  }
});

test('computeIndexStatus reports "current" when the snapshot fingerprint matches and "stale" otherwise', () => {
  const commonDir = freshTmpDir();
  try {
    const layout = layoutFor(commonDir);
    ensureScaffolding(layout);
    const gp = generationPaths(layout, 'g-1');
    writeManifestAtomic(gp.manifestFile, sampleManifest());
    publishCurrentGenerationId(layout, 'g-1');

    const current = computeIndexStatus({ commonDir, objectFormat: 'sha1', shallow: false, currentSnapshotFingerprint: 'snap-1', refsChanged: false });
    assert.equal(current.state, 'current');
    assert.equal(current.recordCount, 7);
    assert.equal(current.model?.id, 'fake');

    const stale = computeIndexStatus({ commonDir, objectFormat: 'sha1', shallow: false, currentSnapshotFingerprint: 'snap-2', refsChanged: true });
    assert.equal(stale.state, 'stale');
  } finally {
    fs.rmSync(commonDir, { recursive: true, force: true });
  }
});

test('computeIndexStatus reports "recovery_required" when a pending batch marker exists', () => {
  const commonDir = freshTmpDir();
  try {
    const layout = layoutFor(commonDir);
    ensureScaffolding(layout);
    const gp = generationPaths(layout, 'g-1');
    writeManifestAtomic(gp.manifestFile, sampleManifest());
    publishCurrentGenerationId(layout, 'g-1');
    writePendingBatch(gp.pendingFile, { version: 1, generationId: 'g-1', startedAt: new Date().toISOString(), commitShas: ['deadbeef'] });

    const status = computeIndexStatus({ commonDir, objectFormat: 'sha1', shallow: false, currentSnapshotFingerprint: 'snap-1', refsChanged: false });
    assert.equal(status.state, 'recovery_required');
  } finally {
    fs.rmSync(commonDir, { recursive: true, force: true });
  }
});

test('computeIndexStatus reports "rebuild_required" when manifest policy versions are incompatible', () => {
  const commonDir = freshTmpDir();
  try {
    const layout = layoutFor(commonDir);
    ensureScaffolding(layout);
    const gp = generationPaths(layout, 'g-1');
    writeManifestAtomic(gp.manifestFile, sampleManifest({ recordSchemaVersion: 999 }));
    publishCurrentGenerationId(layout, 'g-1');

    const status = computeIndexStatus({ commonDir, objectFormat: 'sha1', shallow: false, currentSnapshotFingerprint: 'snap-1', refsChanged: false });
    assert.equal(status.state, 'rebuild_required');
  } finally {
    fs.rmSync(commonDir, { recursive: true, force: true });
  }
});
