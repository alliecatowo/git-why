/**
 * The CLI's view of the rest of the system.
 *
 * No module under `src/git/`, `src/index/`, `src/embedding/`, `src/history/`
 * or `src/search/` exists yet at the time this file was written. Rather than
 * import from those directories (forbidden by lane ownership) or stub them
 * (also forbidden), the CLI defines the narrow surface it actually needs and
 * codes against it. `src/cli/wire.ts` is where the integrator plugs in the
 * real implementation once those lanes land.
 *
 * Everything here composes only with `src/types.ts`.
 */

import type { IndexStatus, RepositoryIdentity, SearchRequest, SearchResponse } from '../types.js';

/** A resolved, open repository. Opaque beyond its identity. */
export interface RepositoryHandle {
  readonly identity: RepositoryIdentity;
}

/** One stage of user-visible progress, always rendered to stderr. */
export interface ProgressEvent {
  readonly stage: 'model' | 'extraction' | 'embedding' | 'reconcile' | 'compaction' | 'gc' | 'recovery';
  /** Short, human-readable, already complete (no trailing punctuation required). */
  readonly message: string;
}

export type ProgressListener = (event: ProgressEvent) => void;

/** Options shared by every operation that may touch the index. */
export interface RunOptions {
  /** Forbids model downloads. Git ingestion never fetches objects regardless. */
  readonly offline: boolean;
  /**
   * Forbids index creation, mutation, recovery and compaction. Requires an
   * existing clean compatible index; searches run read-only against it.
   */
  readonly noRefresh: boolean;
  readonly lockTimeoutMs: number;
  readonly signal: AbortSignal;
  readonly onProgress: ProgressListener;
}

export type StatusOptions = Pick<RunOptions, 'lockTimeoutMs' | 'signal'>;

export interface RebuildOptions extends RunOptions {
  /** `rebuild --use-default-model`: migrate off the recorded model explicitly. */
  readonly useDefaultModel: boolean;
}

/**
 * The backend surface the CLI drives. Implemented for real by the
 * integrator once git/storage/embedding/retrieval land; implemented by a
 * fake for CLI unit and integration tests.
 *
 * Every method throws `GitWhyError` (see `src/types.ts`) for expected
 * failure cases (`NO_REPOSITORY`, `INDEX_BUSY`, `MODEL_UNAVAILABLE`, ...);
 * `main.ts` maps the error's `exitCode` and `code` to process behaviour.
 */
export interface Backend {
  /** Resolves the Git repository containing `cwd`. */
  openRepository(cwd: string): Promise<RepositoryHandle>;

  /** Read-only. Never downloads a model, repairs storage, or starts indexing. */
  getStatus(repo: RepositoryHandle, options: StatusOptions): Promise<IndexStatus>;

  /**
   * Runs a search. Unless `options.noRefresh`, first creates or reconciles
   * the index for the captured snapshot.
   */
  search(repo: RepositoryHandle, request: SearchRequest, options: RunOptions): Promise<SearchResponse>;

  /** `git why index`: create/reconcile, explicitly retrying obtainable missing evidence. */
  index(repo: RepositoryHandle, options: RunOptions): Promise<IndexStatus>;

  /** `git why rebuild` / `rebuild --use-default-model`. */
  rebuild(repo: RepositoryHandle, options: RebuildOptions): Promise<IndexStatus>;

  /** `git why gc`: reconcile without downloading embeddings, compact, never mark new commits complete. */
  gc(repo: RepositoryHandle, options: RunOptions): Promise<IndexStatus>;
}
