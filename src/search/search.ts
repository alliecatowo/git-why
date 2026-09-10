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
  type CommitRecord,
  type ResolvedAnchor,
  type LineageStore,
  type LineageInterval,
  type OrdinalAnswer,
  type TimelineEpisode,
} from '../types.js';
import { chooseEvidence } from './evidence.js';
import { buildStorageFilter } from './filters.js';
import { compileFtsQuery } from './ftsquery.js';
import {
  RRF_K,
  type BranchFetch,
  type RankResult,
  type RankedCommit,
  rankCommits,
} from './rank.js';
import { decomposeQuery } from './temporal/intent.js';
import { applyTemporal, exponentFor, temporalScore } from './temporal/score.js';
import { expandStructuralCandidates } from './expand.js';
import type { ExpandedRank } from './expand.js';

const MAX_MESSAGE_EXCERPT_CHARS = 280;

function queryTokens(query: string): string[] {
  return (query.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) ?? []).filter(
    (token, index, values) => values.indexOf(token) === index,
  );
}

async function selectInterval(
  lineage: LineageStore,
  core: string,
  paths: readonly { readonly value: string }[],
): Promise<{ interval: LineageInterval; viaToken: string | null; viaPath: string | null } | null> {
  for (const path of paths) {
    const interval = await lineage.lookupPath(path.value);
    if (interval !== null) return { interval, viaToken: null, viaPath: path.value };
  }
  for (const token of queryTokens(core)) {
    const interval = await lineage.lookupToken(token);
    if (interval !== null) return { interval, viaToken: token, viaPath: null };
  }
  return null;
}

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
  lineage: LineageStore | null = null,
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

  const decomposition = decomposeQuery(request.query);
  const coreQuery = request.temporal.type === 'none' ? request.query : decomposition.core;
  const rankFor = async (query: string): Promise<RankResult> => {
    const lexicalFetch: BranchFetch | null = wantsLexical
      ? (topK) => store.searchLexical(compileFtsQuery(query), filter, topK)
      : null;
    let semanticFetch: BranchFetch | null = null;
    if (wantsSemantic && embedder !== null) {
      const boundedQuery = embedder.truncateToTokens(query, embedder.maxInputTokens);
      const queryVectorPromise = embedder.embedQuery(boundedQuery);
      semanticFetch = async (topK) => store.searchSemantic(await queryVectorPromise, filter, topK);
    }
    return rankCommits({ n: request.limit, lexicalFetch, semanticFetch });
  };
  const rankResults = await Promise.all([rankFor(coreQuery), ...request.groups.map(rankFor)]);
  const rankResult = rankResults[0]!;
  // `--group ... --fuse` uses commit-level RRF across independently retrieved
  // groups. Evidence remains from the primary group, avoiding a misleading
  // claim that a group-specific match was direct evidence for the core query.
  const ranked: readonly RankedCommit[] =
    rankResults.length === 1
      ? rankResult.ranked
      : [
          ...new Map(
            rankResults.flatMap((result) => result.ranked.map((hit) => [hit.sha, hit] as const)),
          ).values(),
        ]
          .map((hit) => ({
            ...hit,
            score: rankResults.reduce((sum, result) => {
              const index = result.ranked.findIndex((candidate) => candidate.sha === hit.sha);
              return sum + (index < 0 ? 0 : 1 / (RRF_K + index + 1));
            }, 0),
          }))
          .sort((a, b) => b.score - a.score || (a.sha < b.sha ? -1 : 1));
  // The ordinary path deliberately remains byte-identical: no table access,
  // no expansion, and the same top-N truncation as before temporal retrieval.
  const temporalRanksForExpansion =
    request.temporal.type !== 'none' && lineage !== null
      ? await expandStructuralCandidates(ranked, lineage)
      : ranked;
  const candidateRanks =
    request.temporal.type === 'none' ? ranked.slice(0, request.limit) : temporalRanksForExpansion;
  const commits = await store.fetchCommits(candidateRanks.map((r) => r.sha));

  const warnings: string[] = [];
  for (const candidate of candidateRanks) {
    if (!commits.has(candidate.sha)) {
      warnings.push(
        `Ranked commit ${candidate.sha} could not be fetched and was omitted from results.`,
      );
    }
  }
  if (
    request.temporal.type === 'none' &&
    request.sort === 'relevance' &&
    FIRST_INTRODUCTION_RE.test(request.query)
  ) {
    warnings.push(
      'This looks like a "when was this first introduced?" question. Relevance ranking favors recent, vocabulary-rich matches, so the originating commit may rank below the default result count. Try widening the candidate pool and ordering chronologically: -n 20 --sort=oldest.',
    );
  }
  const candidateCommits = candidateRanks
    .map((rank) => ({ rank, commit: commits.get(rank.sha) }))
    .filter(
      (value): value is { rank: RankedCommit; commit: CommitRecord } => value.commit !== undefined,
    );
  // A deterministic topological order of the retrieved subgraph. Parent
  // edges, not author/committer timestamps, decide ordinal temporal intent.
  const bySha = new Map(candidateCommits.map(({ commit }) => [commit.sha, commit]));
  const children = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const { commit } of candidateCommits) indegree.set(commit.sha, 0);
  for (const { commit } of candidateCommits)
    for (const parent of commit.parents) {
      if (!bySha.has(parent)) continue;
      indegree.set(commit.sha, (indegree.get(commit.sha) ?? 0) + 1);
      const list = children.get(parent) ?? [];
      list.push(commit.sha);
      children.set(parent, list);
    }
  const ready = [...indegree]
    .filter(([, n]) => n === 0)
    .map(([sha]) => sha)
    .sort();
  const ordinal = new Map<string, number>();
  while (ready.length > 0) {
    const sha = ready.shift()!;
    ordinal.set(sha, ordinal.size);
    for (const child of children.get(sha) ?? []) {
      const n = (indegree.get(child) ?? 1) - 1;
      indegree.set(child, n);
      if (n === 0) {
        ready.push(child);
        ready.sort();
      }
    }
  }
  // Disconnected/incomplete candidate graphs still receive a stable DAG-free
  // fallback; timestamps are intentionally never used for ordinal ordering.
  for (const sha of [...bySha.keys()].sort()) if (!ordinal.has(sha)) ordinal.set(sha, ordinal.size);
  const resolveAnchor = (anchor: typeof request.temporal.anchor): ResolvedAnchor | null => {
    if (anchor === null) return null;
    if (anchor.kind === 'date') return { anchor, sha: null, epochSeconds: anchor.epochSeconds };
    if (anchor.kind === 'sha') {
      const commit = candidateCommits.find(({ commit }) => commit.sha.startsWith(anchor.sha));
      return {
        anchor,
        sha: commit?.commit.sha ?? null,
        epochSeconds: commit?.commit.committerTime ?? null,
      };
    }
    return { anchor, sha: null, epochSeconds: null };
  };
  const anchor = resolveAnchor(request.temporal.anchor);
  const anchorEnd = resolveAnchor(request.temporal.anchorEnd);
  const w = exponentFor(request.temporal);
  const temporalRanks = candidateCommits
    .map(({ rank, commit }) => {
      const temporal = temporalScore(
        {
          sha: commit.sha,
          ordinal: ordinal.get(commit.sha) ?? 0,
          committerTime: commit.committerTime,
        },
        request.temporal,
        {
          candidateCount: candidateCommits.length,
          anchorTime: anchor?.epochSeconds,
          anchorEndTime: anchorEnd?.epochSeconds,
        },
      );
      return { rank, commit, temporal, final: applyTemporal(rank.score, temporal, w) };
    })
    .sort((a, b) => b.final - a.final || (a.commit.sha < b.commit.sha ? -1 : 1))
    .slice(0, request.limit);
  const results: CommitHit[] = [];
  for (const { rank: r, commit, temporal, final } of temporalRanks) {
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
      rankScore: final,
      // The temporal layer replaces these when a constraint is in force. With
      // the identity constraint, `final` is exactly the fused RRF value.
      scores: { fused: r.score, temporal, final },
      matchedBy: r.matchedBy,
      evidence,
      linkDistance: (r as ExpandedRank).linkDistance ?? 0,
    });
  }

  const selectedInterval =
    lineage === null ? null : await selectInterval(lineage, coreQuery, request.filters.paths);
  let answer: OrdinalAnswer | null = null;
  if (selectedInterval !== null) {
    const { interval, viaToken, viaPath } = selectedInterval;
    const endpoint =
      request.temporal.type === 'first'
        ? interval.firstAddedSha
        : request.temporal.type === 'last'
          ? interval.lastAddedSha
          : request.temporal.type === 'removed'
            ? interval.lastRemovedSha
            : null;
    if (endpoint !== null) {
      answer = {
        sha: endpoint,
        kind:
          request.temporal.type === 'removed'
            ? 'removed'
            : request.temporal.type === 'last'
              ? 'last_modified'
              : 'introduced',
        viaToken,
        viaPath,
        confidence: request.temporal.confidence,
      };
    }
  }
  let timeline: TimelineEpisode[] | null = null;
  if (request.temporal.type === 'timeline' && selectedInterval !== null) {
    const timelineCommits = await store.fetchCommits(selectedInterval.interval.chain);
    timeline = selectedInterval.interval.chain.flatMap((sha) => {
      const commit = timelineCommits.get(sha);
      if (commit === undefined) return [];
      const kind: TimelineEpisode['kind'] =
        sha === selectedInterval.interval.firstAddedSha
          ? 'introduced'
          : sha === selectedInterval.interval.lastRemovedSha
            ? 'removed'
            : 'modified';
      return [
        { sha, kind, committerTime: commit.committerTime, subject: commit.subject, evidence: null },
      ];
    });
  }

  return {
    query: request.query,
    coreQuery,
    mode: request.mode,
    sort: request.sort,
    snapshot,
    results: applySort(results, request.sort),
    temporal: {
      intent: request.temporal.type,
      confidence: request.temporal.confidence,
      anchor,
      anchorEnd,
      w,
    },
    answer,
    timeline,
    warnings,
    candidateLimitReached: rankResults.some((result) => result.candidateLimitReached),
  };
}
