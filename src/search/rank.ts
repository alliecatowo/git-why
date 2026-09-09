/**
 * The ranking algorithm (spec section 14), exactly:
 *
 *  1. Fetch up to `max(80, 16*n)` eligible records from each branch,
 *     subject to an implementation cap.
 *  2. Within each branch, collapse records to unique commits ordered by
 *     best record score, with a deterministic (full-SHA) tie-break.
 *  3. Assign ranks AFTER the collapse, so many hunks from one commit
 *     cannot displace many distinct commit ranks.
 *  4. Fuse with RRF at k=60. A missing branch contributes zero.
 *  5. Never add raw BM25/cosine values; never invent a probability.
 *  6. Geometric candidate-pool expansion up to a bounded cap or
 *     exhaustion, exposing `candidateLimitReached` when the cap still
 *     limits diversity below what was requested.
 *  7. No corroboration bonus: this module never counts *how many* records
 *     from a commit appear, only the best one per branch.
 *
 * Zvec's `multiQuery` has a built-in RRF rerank -- deliberately not used
 * here, because it fuses at the *record* level (step 3 is exactly the fix
 * for that: twenty hunks from a huge commit must not out-rank twenty
 * distinct commits). We issue two separate `topK` queries per branch and
 * fuse unique-commit rankings ourselves.
 */
import type { MatchedBy, ScoredRecord } from '../types.js';

export const MIN_CANDIDATE_POOL = 80;
export const CANDIDATE_POOL_MULTIPLIER = 16;
/**
 * Implementation cap on candidate-pool expansion. The spec defers the
 * exact number to "an implementation cap established by the probe"; the
 * storage-lane spike did not report a hard ceiling on `topK` itself (only
 * on filter-expression grammar), so this stays a conservative, easily
 * tuned default pending that measurement.
 */
export const DEFAULT_CANDIDATE_POOL_CAP = 2000;

export const RRF_K = 60;

export type BranchFetch = (topK: number) => Promise<readonly ScoredRecord[]>;

interface BranchResult {
  readonly commitOrder: readonly string[];
  readonly recordsBySha: ReadonlyMap<string, readonly ScoredRecord[]>;
  readonly limitReached: boolean;
}

function collapseToCommitOrder(records: readonly ScoredRecord[]): string[] {
  const best = new Map<string, number>();
  for (const r of records) {
    const prev = best.get(r.sha);
    if (prev === undefined || r.score > prev) best.set(r.sha, r.score);
  }
  return [...best.entries()]
    .sort(([shaA, scoreA], [shaB, scoreB]) =>
      scoreB !== scoreA ? scoreB - scoreA : shaA < shaB ? -1 : shaA > shaB ? 1 : 0,
    )
    .map(([sha]) => sha);
}

function groupBySha(records: readonly ScoredRecord[]): Map<string, ScoredRecord[]> {
  const map = new Map<string, ScoredRecord[]>();
  for (const r of records) {
    const list = map.get(r.sha);
    if (list) list.push(r);
    else map.set(r.sha, [r]);
  }
  return map;
}

async function runBranch(fetch: BranchFetch, n: number, cap: number): Promise<BranchResult> {
  let topK = Math.min(Math.max(MIN_CANDIDATE_POOL, CANDIDATE_POOL_MULTIPLIER * n), cap);
  let records: readonly ScoredRecord[] = [];
  let limitReached = false;

  for (;;) {
    records = await fetch(topK);
    const uniqueCount = new Set(records.map((r) => r.sha)).size;
    const exhausted = records.length < topK; // the store had no more to give
    if (uniqueCount >= n || exhausted) {
      limitReached = !exhausted && uniqueCount < n && topK >= cap;
      break;
    }
    if (topK >= cap) {
      limitReached = true;
      break;
    }
    topK = Math.min(topK * 2, cap);
  }

  return {
    commitOrder: collapseToCommitOrder(records),
    recordsBySha: groupBySha(records),
    limitReached,
  };
}

function rrfContribution(order: readonly string[], k: number): Map<string, number> {
  const scores = new Map<string, number>();
  order.forEach((sha, idx) => scores.set(sha, 1 / (k + idx + 1)));
  return scores;
}

export interface RankedCommit {
  readonly sha: string;
  /** RRF fused value (or the single-branch equivalent). A ranking number, never a confidence. */
  readonly score: number;
  readonly matchedBy: readonly MatchedBy[];
}

export interface RankResult {
  /** Full-SHA tie-broken, best score first. Not yet truncated to the request limit. */
  readonly ranked: readonly RankedCommit[];
  readonly candidateLimitReached: boolean;
  readonly lexicalRecordsBySha: ReadonlyMap<string, readonly ScoredRecord[]>;
  readonly semanticRecordsBySha: ReadonlyMap<string, readonly ScoredRecord[]>;
}

export interface RankInputs {
  /** Distinct commits desired. */
  readonly n: number;
  readonly candidatePoolCap?: number;
  readonly k?: number;
  /** Null when this mode does not use the branch (e.g. `--text` with no embedder loaded). */
  readonly lexicalFetch: BranchFetch | null;
  readonly semanticFetch: BranchFetch | null;
}

const EMPTY_BRANCH: BranchResult = {
  commitOrder: [],
  recordsBySha: new Map(),
  limitReached: false,
};

export async function rankCommits(inputs: RankInputs): Promise<RankResult> {
  const cap = inputs.candidatePoolCap ?? DEFAULT_CANDIDATE_POOL_CAP;
  const k = inputs.k ?? RRF_K;

  const [lexical, semantic] = await Promise.all([
    inputs.lexicalFetch
      ? runBranch(inputs.lexicalFetch, inputs.n, cap)
      : Promise.resolve(EMPTY_BRANCH),
    inputs.semanticFetch
      ? runBranch(inputs.semanticFetch, inputs.n, cap)
      : Promise.resolve(EMPTY_BRANCH),
  ]);

  const lexicalScores = rrfContribution(lexical.commitOrder, k);
  const semanticScores = rrfContribution(semantic.commitOrder, k);

  const allShas = new Set<string>([...lexicalScores.keys(), ...semanticScores.keys()]);
  const ranked: RankedCommit[] = [...allShas].map((sha) => {
    const score = (lexicalScores.get(sha) ?? 0) + (semanticScores.get(sha) ?? 0);
    const matchedBy: MatchedBy[] = [];
    if (lexicalScores.has(sha)) matchedBy.push('text');
    if (semanticScores.has(sha)) matchedBy.push('semantic');
    return { sha, score, matchedBy };
  });

  ranked.sort((a, b) =>
    b.score !== a.score ? b.score - a.score : a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0,
  );

  const candidateLimitReached =
    allShas.size < inputs.n && (lexical.limitReached || semantic.limitReached);

  return {
    ranked,
    candidateLimitReached,
    lexicalRecordsBySha: lexical.recordsBySha,
    semanticRecordsBySha: semantic.recordsBySha,
  };
}
