/**
 * Top-level search: `SearchRequest` + `HistoryStore` + `Embedder` +
 * `SnapshotSummary` -> `SearchResponse`.
 *
 * Eligibility filters are identical in both branches (both go through
 * `buildStorageFilter` into the same `StorageFilter`, applied by the store
 * before top-k -- see `src/types.ts`, `HistoryStore`). For `--text`,
 * `embedder` may be `null`: this function never calls it in that case, so
 * a caller with a current index and `mode: 'text'` never needs to load the
 * embedding model at all.
 */
import {
  GitWhyError,
  type CommitHit,
  type Embedder,
  type HistoryStore,
  type ResultSort,
  type SearchRequest,
  type SearchResponse,
  type SnapshotSummary,
  type StorageFilter,
} from '../types.js';
import { chooseEvidence } from './evidence.js';
import { buildStorageFilter } from './filters.js';
import { compileFtsQuery } from './ftsquery.js';
import { type BranchFetch, rankCommits } from './rank.js';

const MAX_MESSAGE_EXCERPT_CHARS = 280;

/**
 * Benchmark-only affordance for the summaries-only ablation required by
 * docs/spec.md section 18 ("does diff ingestion earn its complexity?").
 *
 * The comparison needs retrieval restricted to commit summaries while the
 * index itself is unchanged. This is deliberately an environment variable and
 * not a CLI flag: it is an evaluation control, not a product feature, and
 * `bench/` may not import product internals to fabricate the comparison.
 * Unset (the normal case) retrieves both record types.
 */
function benchRecordTypes(): ('commit' | 'evidence')[] {
  return process.env.GIT_WHY_BENCH_RECORD_TYPES === 'commit' ? ['commit'] : ['commit', 'evidence'];
}

/**
 * Reorders the already-selected commits. Retrieval is unchanged: the same set
 * comes back whatever the sort, so chronology can never smuggle in a commit
 * that relevance did not choose. Ties break on full SHA so the order is total
 * and reproducible.
 */
function applySort(results: readonly CommitHit[], sort: ResultSort): CommitHit[] {
  if (sort === 'relevance') return [...results];
  const direction = sort === 'newest' ? -1 : 1;
  return [...results].sort((a, b) => {
    if (a.committerTime !== b.committerTime) return direction * (a.committerTime - b.committerTime);
    return a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0;
  });
}

/**
 * Detects "when was this first introduced?" style questions. The v2
 * real-repository benchmark (docs/report.md 4c) shows these are the weak
 * spot: terse origin commits lose to newer lexical traps under relevance
 * ranking, and no post-hoc sort can rescue a commit that was never
 * selected. The honest answer is the widen-then-order usage pattern, so a
 * matching query with default relevance ordering gets a warning pointing
 * at it. This never changes ranking or selection -- it is a hint only.
 */
const FIRST_INTRODUCTION_RE =
  /\bwhen\s+(was|did)\b|\bfirst\s+(introduced|added|created|landed|merged|appeared)\b|\boriginally\b|\bearliest\b/i;

function messageExcerptOf(subject: string, body: string): string {
  const combined = body.length > 0 ? `${subject}\n\n${body}` : subject;
  if (combined.length <= MAX_MESSAGE_EXCERPT_CHARS) return combined;
  return `${combined.slice(0, MAX_MESSAGE_EXCERPT_CHARS)}…`;
}

export async function search(
  request: SearchRequest,
  store: HistoryStore,
  embedder: Embedder | null,
  snapshot: SnapshotSummary,
): Promise<SearchResponse> {
  const wantsLexical = request.mode === 'text' || request.mode === 'hybrid';
  const wantsSemantic = request.mode === 'semantic' || request.mode === 'hybrid';

  if (wantsSemantic && embedder === null) {
    throw new GitWhyError(
      'INTERNAL',
      'Semantic search requires an embedder, but none was provided to search().',
    );
  }

  const filter: StorageFilter = buildStorageFilter(request.filters, benchRecordTypes());

  const lexicalFetch: BranchFetch | null = wantsLexical
    ? (topK) => store.searchLexical(compileFtsQuery(request.query), filter, topK)
    : null;

  let semanticFetch: BranchFetch | null = null;
  if (wantsSemantic && embedder !== null) {
    const boundedQuery = embedder.truncateToTokens(request.query, embedder.maxInputTokens);
    const queryVectorPromise = embedder.embedQuery(boundedQuery);
    semanticFetch = async (topK) => store.searchSemantic(await queryVectorPromise, filter, topK);
  }

  const rankResult = await rankCommits({ n: request.limit, lexicalFetch, semanticFetch });
  const top = rankResult.ranked.slice(0, request.limit);
  const commits = await store.fetchCommits(top.map((r) => r.sha));

  const warnings: string[] = [];
  if (request.sort === 'relevance' && FIRST_INTRODUCTION_RE.test(request.query)) {
    warnings.push(
      'This looks like a "when was this first introduced?" question. Relevance ranking favors recent, vocabulary-rich matches, so the originating commit may rank below the default result count. Try widening the candidate pool and ordering chronologically: -n 20 --sort=oldest.',
    );
  }
  const results: CommitHit[] = [];
  for (const r of top) {
    const commit = commits.get(r.sha);
    if (commit === undefined) {
      warnings.push(`Ranked commit ${r.sha} could not be fetched and was omitted from results.`);
      continue;
    }
    const evidence = await chooseEvidence(
      rankResult.lexicalRecordsBySha.get(r.sha) ?? [],
      rankResult.semanticRecordsBySha.get(r.sha) ?? [],
      store,
      2,
    );

    results.push({
      sha: commit.sha,
      subject: commit.subject,
      author: { name: commit.author.name, email: commit.author.email },
      authorTime: commit.author.time,
      committerTime: commit.committerTime,
      parents: commit.parents,
      messageExcerpt: messageExcerptOf(commit.subject, commit.body),
      rankScore: r.score,
      // The temporal layer replaces these when a constraint is in force. With
      // the identity constraint, `final` is exactly the fused RRF value.
      scores: { fused: r.score, temporal: 1, final: r.score },
      matchedBy: r.matchedBy,
      evidence,
      linkDistance: 0,
    });
  }

  return {
    query: request.query,
    coreQuery: request.query,
    mode: request.mode,
    sort: request.sort,
    snapshot,
    results: applySort(results, request.sort),
    temporal: {
      intent: request.temporal.type,
      confidence: request.temporal.confidence,
      anchor: null,
      anchorEnd: null,
      w: 0,
    },
    answer: null,
    timeline: null,
    warnings,
    candidateLimitReached: rankResult.candidateLimitReached,
  };
}
