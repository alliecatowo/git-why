/**
 * The generation manifest (spec section 11): small metadata only, no
 * embeddings, no patches, no giant commit arrays. Atomic read/write via
 * temp file + fsync + rename on the same filesystem as the target.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ObjectFormat, OmissionReason } from '../types.js';
import {
  GitWhyError,
  MANIFEST_VERSION,
  RECORD_SCHEMA_VERSION,
  EXTRACTION_POLICY_VERSION,
  LEXICAL_NORMALIZATION_VERSION,
  RANKING_VERSION,
} from '../types.js';
import { fsyncDirectoryBestEffort } from './layout.js';

export type ManifestState = 'clean' | 'recovery_required';

export interface ManifestCounts {
  readonly commits: number;
  readonly evidence: number;
}

export interface ManifestOmissionCounts {
  readonly excludedFiles: number;
  readonly unavailableFiles: number;
  readonly failedFiles: number;
  readonly reasons: readonly OmissionReason[];
}

/** Everything needed to decide whether a generation is usable and current. */
export interface IndexManifest {
  readonly manifestVersion: number;
  readonly recordSchemaVersion: number;
  readonly extractionPolicyVersion: number;
  readonly lexicalNormalizationVersion: number;
  readonly embeddingModelId: string;
  readonly embeddingModelRevision: string;
  readonly embeddingFingerprint: string;
  readonly rankingVersion: number;
  readonly objectFormat: ObjectFormat;
  /** `RepositorySnapshot.fingerprint` this generation was built (or last reconciled) against. */
  readonly snapshotFingerprint: string;
  /** Identifies the on-disk Zvec format this generation was written with (installed package version). */
  readonly databaseFormatCompatibility: string;
  readonly counts: ManifestCounts;
  readonly omissions: ManifestOmissionCounts;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly state: ManifestState;
  readonly generationId: string;
}

export function currentPolicyIdentities(): Pick<
  IndexManifest,
  | 'manifestVersion'
  | 'recordSchemaVersion'
  | 'extractionPolicyVersion'
  | 'lexicalNormalizationVersion'
  | 'rankingVersion'
> {
  return {
    manifestVersion: MANIFEST_VERSION,
    recordSchemaVersion: RECORD_SCHEMA_VERSION,
    extractionPolicyVersion: EXTRACTION_POLICY_VERSION,
    lexicalNormalizationVersion: LEXICAL_NORMALIZATION_VERSION,
    rankingVersion: RANKING_VERSION,
  };
}

/** True when a candidate manifest's versioned policy identities all match what this build expects. */
export function manifestPolicyIsCompatible(manifest: IndexManifest): boolean {
  const current = currentPolicyIdentities();
  return (
    manifest.manifestVersion === current.manifestVersion &&
    manifest.recordSchemaVersion === current.recordSchemaVersion &&
    manifest.extractionPolicyVersion === current.extractionPolicyVersion &&
    manifest.lexicalNormalizationVersion === current.lexicalNormalizationVersion &&
    manifest.rankingVersion === current.rankingVersion
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Structural validation only — policy-compatibility is a separate, explicit check. */
function validateManifestShape(value: unknown, sourcePath: string): IndexManifest {
  if (!isPlainObject(value)) {
    throw new GitWhyError('INDEX_CORRUPT', `manifest at ${sourcePath} is not an object`);
  }
  const requiredStrings = [
    'embeddingModelId',
    'embeddingModelRevision',
    'embeddingFingerprint',
    'objectFormat',
    'snapshotFingerprint',
    'databaseFormatCompatibility',
    'createdAt',
    'updatedAt',
    'state',
    'generationId',
  ];
  for (const key of requiredStrings) {
    if (typeof value[key] !== 'string') {
      throw new GitWhyError(
        'INDEX_CORRUPT',
        `manifest at ${sourcePath} missing/invalid string field "${key}"`,
      );
    }
  }
  const requiredNumbers = [
    'manifestVersion',
    'recordSchemaVersion',
    'extractionPolicyVersion',
    'lexicalNormalizationVersion',
    'rankingVersion',
  ];
  for (const key of requiredNumbers) {
    if (typeof value[key] !== 'number') {
      throw new GitWhyError(
        'INDEX_CORRUPT',
        `manifest at ${sourcePath} missing/invalid numeric field "${key}"`,
      );
    }
  }
  if (
    !isPlainObject(value.counts) ||
    typeof value.counts.commits !== 'number' ||
    typeof value.counts.evidence !== 'number'
  ) {
    throw new GitWhyError('INDEX_CORRUPT', `manifest at ${sourcePath} has invalid "counts"`);
  }
  if (
    !isPlainObject(value.omissions) ||
    typeof value.omissions.excludedFiles !== 'number' ||
    typeof value.omissions.unavailableFiles !== 'number' ||
    typeof value.omissions.failedFiles !== 'number' ||
    !Array.isArray(value.omissions.reasons)
  ) {
    throw new GitWhyError('INDEX_CORRUPT', `manifest at ${sourcePath} has invalid "omissions"`);
  }
  if (value.state !== 'clean' && value.state !== 'recovery_required') {
    throw new GitWhyError(
      'INDEX_CORRUPT',
      `manifest at ${sourcePath} has invalid "state": ${String(value.state)}`,
    );
  }
  if (value.objectFormat !== 'sha1' && value.objectFormat !== 'sha256') {
    throw new GitWhyError(
      'INDEX_CORRUPT',
      `manifest at ${sourcePath} has invalid "objectFormat": ${String(value.objectFormat)}`,
    );
  }
  return value as unknown as IndexManifest;
}

/** Returns null when no manifest file exists yet (a fresh/staging generation). */
export function readManifest(manifestFile: string): IndexManifest | null {
  let raw: string;
  try {
    raw = fs.readFileSync(manifestFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new GitWhyError(
      'STORAGE_FAILED',
      `failed to read manifest at ${manifestFile}: ${(err as Error).message}`,
      { cause: err },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new GitWhyError('INDEX_CORRUPT', `manifest at ${manifestFile} is not valid JSON`, {
      cause: err,
    });
  }
  return validateManifestShape(parsed, manifestFile);
}

/** Atomic write: temp file in the same directory, fsync, rename, best-effort directory fsync. */
export function writeManifestAtomic(manifestFile: string, manifest: IndexManifest): void {
  const dir = path.dirname(manifestFile);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.manifest.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(manifest, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, manifestFile);
  fsyncDirectoryBestEffort(dir);
}
