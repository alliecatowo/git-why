/** Structural candidate growth for temporal queries.
 *
 * This is intentionally not a wider retrieval top-k.  Only commits linked
 * from a semantic/lexical seed by the generation's lineage table are added,
 * and every added score is discounted by graph hop count.
 */
import type { LineageStore, MatchedBy } from '../types.js';
import type { RankedCommit } from './rank.js';

export interface ExpandedRank extends RankedCommit {
  readonly linkDistance: number;
}

export const LINK_HOP_DISCOUNT = 0.72;

/**
 * Hard ceiling on commits added by expansion, over and above the seeds.
 *
 * A hot path key -- a file every commit touches, or a token like `err` that
 * survives the identifier filter -- can be linked to a large fraction of the
 * history. Without a ceiling the candidate set grows towards the whole
 * repository, which defeats the purpose (expansion is supposed to be
 * structural, not a wider net) and, on a large repository, produced a hard
 * failure: the downstream `sha IN (...)` lookup exceeded the storage engine's
 * 20,000-term limit and the entire query returned INTERNAL. That failed only
 * on histories above the limit, so it was invisible on every small fixture.
 *
 * Expanded commits are already ordered by discounted score, so truncating
 * keeps the best-linked ones.
 */
export const MAX_EXPANDED_COMMITS = 200;

export async function expandStructuralCandidates(
  seeds: readonly RankedCommit[],
  lineage: LineageStore,
  maxSeeds = 12,
  maxHops = 1,
  maxExpanded = MAX_EXPANDED_COMMITS,
): Promise<ExpandedRank[]> {
  const seedShas = new Set(seeds.map((seed) => seed.sha));
  const added = new Map<string, ExpandedRank>();

  for (const seed of seeds.slice(0, maxSeeds)) {
    const links = await lineage.linkedCommits(seed.sha, maxHops);
    for (const [sha, distance] of links) {
      if (distance < 1 || distance > maxHops) continue;
      // Seeds keep their own retrieval score; a link must never demote one.
      if (seedShas.has(sha)) continue;
      const score = seed.score * LINK_HOP_DISCOUNT ** distance;
      const current = added.get(sha);
      if (current !== undefined && current.score >= score) continue;
      added.set(sha, {
        sha,
        score,
        matchedBy: ['linked'] as readonly MatchedBy[],
        linkDistance: distance,
      });
    }
  }

  const byScore = (a: ExpandedRank, b: ExpandedRank): number =>
    b.score - a.score || a.sha.localeCompare(b.sha);

  // Truncate the ADDED commits only. Seeds were earned by retrieval and are
  // never dropped to make room for a link.
  const kept = [...added.values()].sort(byScore).slice(0, maxExpanded);
  const all = [...seeds.map((seed) => ({ ...seed, linkDistance: 0 })), ...kept];
  return all.sort(byScore);
}
