/**
 * Shared contracts for Git Why.
 *
 * These are the public boundaries between lanes:
 *   extraction -> records, records -> storage, query -> structured results,
 *   results -> rendering.
 *
 * Nothing in this file may import from another `src/` module. Every lane
 * depends on it, so it must stay small, stable, and free of behaviour.
 */

/* ------------------------------------------------------------------ *
 * Versioned policy identities
 * ------------------------------------------------------------------ */

/** Bumping any of these invalidates an existing index generation. */
export const MANIFEST_VERSION = 1;
export const RECORD_SCHEMA_VERSION = 1;
export const EXTRACTION_POLICY_VERSION = 1;
export const LEXICAL_NORMALIZATION_VERSION = 1;
export const RANKING_VERSION = 1;
export const DOC_ID_VERSION = 1;
/** Version of the `--json` envelope. */
export const JSON_SCHEMA_VERSION = 1;

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

/** Process exit codes. See docs/operations.md. */
export const ExitCode = {
  OK: 0,
  INVALID_INVOCATION: 2,
  NO_REPOSITORY: 3,
  INDEX_FAILURE: 4,
  LOCK_TIMEOUT: 5,
  INTERRUPTED: 130,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * Machine-readable error codes. The exit code alone does not distinguish
 * the cause of a class-4 failure; this does.
 */
export type GitWhyErrorCode =
  | 'INVALID_ARGUMENTS'
  | 'EMPTY_QUERY'
  | 'CONTRADICTORY_MODES'
  | 'INVALID_DATE'
  | 'INVALID_LIMIT'
  | 'INVALID_PATH_RESTRICTION'
  | 'UNSUPPORTED_PATHSPEC'
  | 'NO_REPOSITORY'
  | 'UNSUPPORTED_HISTORY_OVERRIDE'
  | 'INDEX_MISSING'
  | 'INDEX_STALE'
  | 'INDEX_BUSY'
  | 'INDEX_RECOVERY_REQUIRED'
  | 'INDEX_REBUILD_REQUIRED'
  | 'INDEX_INCOMPATIBLE'
  | 'INDEX_CORRUPT'
  | 'MODEL_UNAVAILABLE'
  | 'MODEL_DOWNLOAD_FAILED'
  | 'MODEL_MISMATCH'
  | 'OFFLINE_REQUIRED_RESOURCE'
  | 'EXTRACTION_FAILED'
  | 'STORAGE_FAILED'
  | 'LOCK_TIMEOUT'
  | 'INTERRUPTED'
  | 'INTERNAL';

/** The single error type crossing module boundaries. */
export class GitWhyError extends Error {
  readonly code: GitWhyErrorCode;
  readonly exitCode: ExitCode;
  readonly hint: string | undefined;

  constructor(
    code: GitWhyErrorCode,
    message: string,
    options: { exitCode?: ExitCode; hint?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'GitWhyError';
    this.code = code;
    this.exitCode = options.exitCode ?? defaultExitCodeFor(code);
    this.hint = options.hint;
  }
}

function defaultExitCodeFor(code: GitWhyErrorCode): ExitCode {
  switch (code) {
    case 'INVALID_ARGUMENTS':
    case 'EMPTY_QUERY':
    case 'CONTRADICTORY_MODES':
    case 'INVALID_DATE':
    case 'INVALID_LIMIT':
    case 'INVALID_PATH_RESTRICTION':
    case 'UNSUPPORTED_PATHSPEC':
      return ExitCode.INVALID_INVOCATION;
    case 'NO_REPOSITORY':
      return ExitCode.NO_REPOSITORY;
    case 'LOCK_TIMEOUT':
    case 'INDEX_BUSY':
      return ExitCode.LOCK_TIMEOUT;
    case 'INTERRUPTED':
      return ExitCode.INTERRUPTED;
    default:
      return ExitCode.INDEX_FAILURE;
  }
}

/* ------------------------------------------------------------------ *
 * Repository identity and snapshot scope
 * ------------------------------------------------------------------ */

export type ObjectFormat = 'sha1' | 'sha256';

export interface RepositoryIdentity {
  /** Absolute, canonicalised Git common directory. Shared by all worktrees. */
  readonly commonDir: string;
  /** Absolute worktree root, or null for a bare repository. */
  readonly worktreeRoot: string | null;
  readonly isBare: boolean;
  readonly isShallow: boolean;
  readonly objectFormat: ObjectFormat;
  /** `<commonDir>/why` — the root of all repository-specific state. */
  readonly stateDir: string;
}

export interface RefTip {
  /** Full ref name, or a synthetic `worktree:<name>:HEAD` identifier. */
  readonly name: string;
  /** Full object ID of the commit this tip peels to. */
  readonly oid: string;
}

/**
 * The captured view of a repository at the start of a reconciliation.
 * Scope: local branches, remote-tracking branches, tags peeling to commits,
 * and the HEAD of every registered accessible worktree.
 */
export interface RepositorySnapshot {
  readonly repository: RepositoryIdentity;
  /** Deduplicated, sorted by name. */
  readonly tips: readonly RefTip[];
  /** Deduplicated, sorted OIDs to feed `git rev-list --stdin`. */
  readonly tipOids: readonly string[];
  /** Contents of `shallow`, sorted; empty for a complete clone. */
  readonly shallowBoundary: readonly string[];
  /**
   * Opaque digest over tips, worktree HEADs, shallow boundary, object format,
   * extraction policy version and the Git extraction configuration.
   */
  readonly fingerprint: string;
  /**
   * False when a registered worktree could not be enumerated. An incomplete
   * snapshot may add records but must never prune.
   */
  readonly complete: boolean;
  readonly capturedAt: number;
  readonly scope: 'branches-remotes-tags-worktree-heads';
}

/* ------------------------------------------------------------------ *
 * Historical paths (byte-preserving)
 * ------------------------------------------------------------------ */

/**
 * A path as it existed in history. Git permits any bytes except NUL, so the
 * original bytes are the identity and the display string is derived.
 */
export interface HistoricalPath {
  /** Base64 of the original path bytes. Always present; this is the identity. */
  readonly bytesBase64: string;
  /** Lossy-decoded UTF-8 for display and for path match keys. */
  readonly display: string;
  /** True when `display` does not round-trip back to `bytesBase64`. */
  readonly lossy: boolean;
}

export type ChangeType =
  | 'A' // added
  | 'C' // copied
  | 'D' // deleted
  | 'M' // modified
  | 'R' // renamed
  | 'T' // type changed
  | 'U' // unmerged
  | 'X'; // unknown

export interface HistoricalPathChange {
  readonly path: HistoricalPath;
  readonly oldPath: HistoricalPath | null;
  readonly changeType: ChangeType;
  /** Rename/copy similarity 0-100, when Git reported one. */
  readonly similarity: number | null;
  readonly oldMode: string | null;
  readonly newMode: string | null;
  readonly oldBlob: string | null;
  readonly newBlob: string | null;
}

/* ------------------------------------------------------------------ *
 * Coverage
 * ------------------------------------------------------------------ */

/** Machine-readable reasons that evidence is absent or reduced. */
export type OmissionReason =
  | 'binary'
  | 'generated'
  | 'lockfile'
  | 'size_limit'
  | 'message_limit'
  | 'slice_limit'
  | 'token_budget'
  | 'path_limit'
  | 'missing_object'
  | 'shallow_boundary'
  | 'merge_hunks_omitted'
  | 'pathological_commit'
  | 'extraction_error';

export interface Coverage {
  /** True when everything the policy asks for was obtained. */
  readonly complete: boolean;
  readonly reasons: readonly OmissionReason[];
  /** Material the policy deliberately excluded. */
  readonly excludedFiles: number;
  /** Material Git could not supply (missing objects, shallow boundary). */
  readonly unavailableFiles: number;
  /** Material that failed to extract despite being expected to work. */
  readonly failedFiles: number;
  readonly truncated: boolean;
}

export const EMPTY_COVERAGE: Coverage = Object.freeze({
  complete: true,
  reasons: Object.freeze([]) as readonly OmissionReason[],
  excludedFiles: 0,
  unavailableFiles: 0,
  failedFiles: 0,
  truncated: false,
});

/* ------------------------------------------------------------------ *
 * History records
 * ------------------------------------------------------------------ */

export type EvidenceKind = 'hunk' | 'file_change';

export interface CommitRecord {
  readonly type: 'commit';
  /** Deterministic document ID. See `src/history/ids.ts`. */
  readonly id: string;
  readonly sha: string;
  readonly parents: readonly string[];
  readonly subject: string;
  readonly body: string;
  readonly author: { readonly name: string; readonly email: string; readonly time: number };
  readonly committerTime: number;
  readonly changedPaths: readonly HistoricalPathChange[];
  /** Input to the embedding model. */
  readonly semanticText: string;
  /** Normalised text for keyword retrieval. */
  readonly lexicalText: string;
  readonly coverage: Coverage;
}

export interface EvidenceRecord {
  readonly type: 'evidence';
  readonly kind: EvidenceKind;
  readonly id: string;
  readonly sha: string;
  readonly parentSha: string | null;
  readonly path: HistoricalPath;
  readonly oldPath: HistoricalPath | null;
  readonly changeType: ChangeType;
  readonly hunkOrdinal: number | null;
  readonly sliceOrdinal: number;
  readonly header: string | null;
  readonly oldStart: number | null;
  readonly oldCount: number | null;
  readonly newStart: number | null;
  readonly newCount: number | null;
  /** Faithful, displayable historical evidence. Never normalised. */
  readonly sourceExcerpt: string;
  readonly semanticText: string;
  readonly lexicalText: string;
  readonly coverage: Coverage;
}

export type HistoryRecord = CommitRecord | EvidenceRecord;

/** One commit's complete extraction output, applied to the index as a unit. */
export interface CommitExtraction {
  readonly commit: CommitRecord;
  readonly evidence: readonly EvidenceRecord[];
}

export interface HistoryExtractor {
  extract(snapshot: RepositorySnapshot, shas: readonly string[]): AsyncIterable<CommitExtraction>;
}

/* ------------------------------------------------------------------ *
 * Embedding
 * ------------------------------------------------------------------ */

export interface Embedder {
  /** Stable identity over weights, tokenizer, pooling, normalisation, dims. */
  readonly fingerprint: string;
  readonly modelId: string;
  readonly revision: string;
  readonly dimension: number;
  readonly maxInputTokens: number;
  countTokens(text: string): number;
  /** Truncate to at most `maxTokens` tokens, on a token boundary. */
  truncateToTokens(text: string, maxTokens: number): string;
  embedDocuments(texts: readonly string[]): Promise<Float32Array[]>;
  embedQuery(text: string): Promise<Float32Array>;
  dispose(): Promise<void>;
}

/* ------------------------------------------------------------------ *
 * Query, filters and results
 * ------------------------------------------------------------------ */

export type SearchMode = 'hybrid' | 'text' | 'semantic';

/**
 * Deterministic ordering applied to the commits retrieval already selected.
 *
 * This is a presentation facet, not a ranking tweak: it never changes WHICH
 * commits are returned, only the order they are shown in. Retrieval stays
 * relevance-driven because similarity is not a causal timeline, and silently
 * favouring recent commits would be wrong. But "when was this first
 * introduced?" is a real question that ranking alone answers badly, so the
 * user can ask for chronology explicitly.
 */
export type ResultSort = 'relevance' | 'newest' | 'oldest';

/** A path restriction: a literal file path, or a directory prefix. */
export interface PathRestriction {
  /** Repository-relative, normalised, no leading `./`, no trailing `/`. */
  readonly value: string;
  readonly kind: 'file' | 'directory';
}

export interface SearchFilters {
  /** ORed together. Empty means no path restriction. */
  readonly paths: readonly PathRestriction[];
  /** Inclusive lower bound, epoch seconds, committer time. */
  readonly after: number | null;
  /** Exclusive upper bound, epoch seconds, committer time. */
  readonly before: number | null;
  /** Case-insensitive literal substring of author name or email. */
  readonly author: string | null;
}

export const NO_FILTERS: SearchFilters = Object.freeze({
  paths: Object.freeze([]) as readonly PathRestriction[],
  after: null,
  before: null,
  author: null,
});

export interface SearchRequest {
  readonly query: string;
  readonly mode: SearchMode;
  readonly sort: ResultSort;
  /** Distinct commits to return, 1-50. */
  readonly limit: number;
  readonly filters: SearchFilters;
}

export type MatchedBy = 'text' | 'semantic';

export interface EvidenceHit {
  readonly recordId: string;
  readonly kind: EvidenceKind;
  readonly path: HistoricalPath;
  readonly oldPath: HistoricalPath | null;
  readonly changeType: ChangeType;
  readonly oldStart: number | null;
  readonly oldCount: number | null;
  readonly newStart: number | null;
  readonly newCount: number | null;
  readonly excerpt: string;
  readonly truncated: boolean;
  readonly omissionReasons: readonly OmissionReason[];
}

export interface CommitHit {
  readonly sha: string;
  readonly subject: string;
  readonly author: { readonly name: string; readonly email: string };
  readonly authorTime: number;
  readonly committerTime: number;
  readonly parents: readonly string[];
  readonly messageExcerpt: string;
  /** RRF value. A ranking number, never a confidence. */
  readonly rankScore: number;
  readonly matchedBy: readonly MatchedBy[];
  readonly evidence: readonly EvidenceHit[];
}

export type Freshness = 'current' | 'stale' | 'unknown';
export type CoverageSummary = 'complete_for_policy' | 'partial' | 'unknown';

export interface SnapshotSummary {
  readonly scope: 'branches-remotes-tags-worktree-heads';
  readonly fingerprint: string;
  /** ISO-8601 UTC, or null when never indexed. */
  readonly indexedAt: string | null;
  readonly freshness: Freshness;
  readonly coverage: CoverageSummary;
  readonly generation: string;
}

export interface SearchResponse {
  readonly query: string;
  readonly mode: SearchMode;
  readonly sort: ResultSort;
  readonly snapshot: SnapshotSummary;
  readonly results: readonly CommitHit[];
  readonly warnings: readonly string[];
  readonly candidateLimitReached: boolean;
}

/* ------------------------------------------------------------------ *
 * Index status
 * ------------------------------------------------------------------ */

export type IndexState =
  | 'missing'
  | 'current'
  | 'stale'
  | 'incomplete'
  | 'busy'
  | 'recovery_required'
  | 'rebuild_required';

export interface IndexStatus {
  readonly state: IndexState;
  readonly indexPath: string;
  readonly generation: string | null;
  readonly indexedCommits: number | null;
  /** Null when a cheap check only established that refs moved. */
  readonly reachableCommits: number | null;
  readonly refsChanged: boolean;
  readonly recordCount: number | null;
  readonly model: {
    readonly id: string;
    readonly revision: string;
    readonly fingerprint: string;
  } | null;
  readonly diskBytes: number | null;
  readonly indexedAt: string | null;
  readonly objectFormat: ObjectFormat;
  readonly shallow: boolean;
  readonly coverage: {
    readonly excludedFiles: number;
    readonly unavailableFiles: number;
    readonly failedFiles: number;
    readonly reasons: readonly OmissionReason[];
  };
  readonly warnings: readonly string[];
}

/* ------------------------------------------------------------------ *
 * Storage boundary
 * ------------------------------------------------------------------ */

/** Records eligible for retrieval, before top-k selection. */
export interface StorageFilter {
  readonly recordTypes: readonly ('commit' | 'evidence')[];
  readonly filters: SearchFilters;
}

export interface ScoredRecord {
  readonly id: string;
  readonly type: 'commit' | 'evidence';
  readonly sha: string;
  /** Native branch score. Comparable only within one branch. */
  readonly score: number;
}

/**
 * The storage engine as the search layer sees it. Implemented by the Zvec
 * adapter in `src/index/`. All eligibility filtering happens inside these
 * calls, never afterwards.
 */
export interface HistoryStore {
  searchLexical(
    queryText: string,
    filter: StorageFilter,
    topK: number,
  ): Promise<readonly ScoredRecord[]>;
  searchSemantic(
    queryVector: Float32Array,
    filter: StorageFilter,
    topK: number,
  ): Promise<readonly ScoredRecord[]>;
  fetchCommits(shas: readonly string[]): Promise<ReadonlyMap<string, CommitRecord>>;
  fetchEvidence(ids: readonly string[]): Promise<ReadonlyMap<string, EvidenceRecord>>;
  /** Evidence for a commit, respecting the same eligibility filters. */
  evidenceForCommit(
    sha: string,
    filter: StorageFilter,
    limit: number,
  ): Promise<readonly EvidenceRecord[]>;
  close(): Promise<void>;
}
