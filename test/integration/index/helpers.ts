// Shared fakes and fixtures for storage integration tests. Real Zvec, real
// filesystem, real child processes where the test calls for them; only the
// extraction and embedding boundaries are faked, exactly as instructed for
// storage-lane tests (a fake `HistoryExtractor`/`Embedder` is fine here —
// the store itself is always the real Zvec-backed one).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  CommitExtraction,
  CommitRecord,
  Embedder,
  EvidenceRecord,
  HistoryExtractor,
  RepositoryIdentity,
  RepositorySnapshot,
} from '../../../src/types.js';
import { EMPTY_COVERAGE } from '../../../src/types.js';

export function freshTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `git-why-${prefix}-`));
}

export function rmDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** A syntactically plausible 40-char commit sha derived from a label, for readable test fixtures. */
export function fakeSha(label: string): string {
  return sha256Hex(label).slice(0, 40);
}

export function fakeRepository(commonDir: string): RepositoryIdentity {
  return {
    commonDir,
    worktreeRoot: commonDir,
    isBare: false,
    isShallow: false,
    objectFormat: 'sha1',
    stateDir: path.join(commonDir, 'why'),
  };
}

export function fakeSnapshot(repository: RepositoryIdentity, tipOids: readonly string[], fingerprint: string, complete = true): RepositorySnapshot {
  return {
    repository,
    tips: tipOids.map((oid, i) => ({ name: `refs/heads/b${i}`, oid })),
    tipOids,
    shallowBoundary: [],
    fingerprint,
    complete,
    capturedAt: Date.now(),
    scope: 'branches-remotes-tags-worktree-heads',
  };
}

export interface FakeCommitSpec {
  readonly sha: string;
  readonly subject?: string;
  readonly committerTime?: number;
  readonly author?: { name: string; email: string };
  readonly paths?: readonly string[];
  readonly evidenceCount?: number;
}

/** Builds a minimal-but-valid CommitExtraction (spec section 8 shape) for a fake commit. */
export function makeExtraction(spec: FakeCommitSpec): CommitExtraction {
  const author = spec.author ?? { name: 'Test Author', email: 'author@example.com', time: spec.committerTime ?? 1000 };
  const committerTime = spec.committerTime ?? 1000;
  const paths = spec.paths ?? [`src/${spec.sha.slice(0, 6)}.ts`];
  const changedPaths = paths.map((p) => ({
    path: { bytesBase64: Buffer.from(p, 'utf8').toString('base64'), display: p, lossy: false },
    oldPath: null,
    changeType: 'M' as const,
    similarity: null,
    oldMode: '100644',
    newMode: '100644',
    oldBlob: null,
    newBlob: null,
  }));
  const subject = spec.subject ?? `Change ${spec.sha.slice(0, 8)}`;
  const commit: CommitRecord = {
    type: 'commit',
    id: sha256Hex(`commit:${spec.sha}`),
    sha: spec.sha,
    parents: [],
    subject,
    body: '',
    author: { name: author.name, email: author.email, time: 'time' in author ? author.time : committerTime },
    committerTime,
    changedPaths,
    semanticText: `${subject}\n${paths.join(', ')}`,
    lexicalText: `${subject} ${paths.join(' ')}`,
    coverage: EMPTY_COVERAGE,
  };
  const evidenceCount = spec.evidenceCount ?? 1;
  const evidence: EvidenceRecord[] = Array.from({ length: evidenceCount }, (_, i) => {
    const p = paths[i % paths.length]!;
    return {
      type: 'evidence',
      kind: 'hunk',
      id: sha256Hex(`evidence:${spec.sha}:${i}`),
      sha: spec.sha,
      parentSha: null,
      path: { bytesBase64: Buffer.from(p, 'utf8').toString('base64'), display: p, lossy: false },
      oldPath: null,
      changeType: 'M',
      hunkOrdinal: i,
      sliceOrdinal: 0,
      header: `@@ -1,1 +1,1 @@`,
      oldStart: 1,
      oldCount: 1,
      newStart: 1,
      newCount: 1,
      sourceExcerpt: `- old line ${i}\n+ new line ${i}`,
      semanticText: `Removed code: old line ${i}\nAdded code: new line ${i}`,
      lexicalText: `old line ${i} new line ${i}`,
      coverage: EMPTY_COVERAGE,
    };
  });
  return { commit, evidence };
}

/**
 * A `HistoryExtractor` over a fixed, in-memory set of extractions.
 * `crashOnSha`, when provided, makes the extractor terminate the process
 * (`process.exit(137)`, deliberately bypassing any cleanup — the same
 * observable effect as a hard kill) the moment it is asked to extract that
 * sha, AFTER printing `marker` to stdout so a parent process can
 * synchronize on it. This gives deterministic crash-injection points
 * without racing a real external SIGKILL against synchronous native calls.
 */
export function makeFakeExtractor(bySha: ReadonlyMap<string, CommitExtraction>, crashOnSha?: string, marker = 'CRASH_POINT'): HistoryExtractor {
  return {
    async *extract(_snapshot, shas) {
      for (const sha of shas) {
        if (sha === crashOnSha) {
          process.stdout.write(`${marker}\n`);
          process.exit(137);
        }
        const extraction = bySha.get(sha);
        if (extraction !== undefined) yield extraction;
      }
    },
  };
}

function hashVector(text: string, dim: number): Float32Array {
  const v = new Float32Array(dim);
  let seed = 0;
  for (let i = 0; i < text.length; i++) seed = (seed * 31 + text.charCodeAt(i)) >>> 0;
  let x = seed || 1;
  for (let i = 0; i < dim; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    v[i] = (x / 0xffffffff) * 2 - 1;
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) v[i] = v[i]! / norm;
  return v;
}

export const FAKE_EMBEDDER_DIMENSION = 16;

/** Deterministic hashed vectors — fine for storage tests, per instructions. Never used to validate embedding quality. */
export function makeFakeEmbedder(dimension = FAKE_EMBEDDER_DIMENSION): Embedder {
  return {
    fingerprint: `fake-embedder-v1-dim${dimension}`,
    modelId: 'fake-hash-embedder',
    revision: '1',
    dimension,
    maxInputTokens: 4096,
    countTokens: (text) => text.split(/\s+/).filter(Boolean).length,
    truncateToTokens: (text, maxTokens) => text.split(/\s+/).slice(0, maxTokens).join(' '),
    embedDocuments: async (texts) => texts.map((t) => hashVector(t, dimension)),
    embedQuery: async (text) => hashVector(text, dimension),
    dispose: async () => {},
  };
}
