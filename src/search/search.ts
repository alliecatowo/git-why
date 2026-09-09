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

  const filter: StorageFilter = buildStorageFilter(request.filters, ['commit', 'evidence']);

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
      matchedBy: r.matchedBy,
      evidence,
    });
  }

  return {
    query: request.query,
    mode: request.mode,
    snapshot,
    results,
    warnings,
    candidateLimitReached: rankResult.candidateLimitReached,
  };
}
