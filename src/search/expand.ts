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

export async function expandStructuralCandidates(
  seeds: readonly RankedCommit[],
  lineage: LineageStore,
  maxSeeds = 12,
  maxHops = 1,
): Promise<ExpandedRank[]> {
  const all = new Map<string, ExpandedRank>();
  for (const seed of seeds) all.set(seed.sha, { ...seed, linkDistance: 0 });
  for (const seed of seeds.slice(0, maxSeeds)) {
    const links = await lineage.linkedCommits(seed.sha, maxHops);
    for (const [sha, distance] of links) {
      if (distance < 1 || distance > maxHops) continue;
      const score = seed.score * LINK_HOP_DISCOUNT ** distance;
      const current = all.get(sha);
      if (current !== undefined && current.score >= score) continue;
      all.set(sha, {
        sha,
        score,
        matchedBy: ['linked'] as readonly MatchedBy[],
        linkDistance: distance,
      });
    }
  }
  return [...all.values()].sort((a, b) => b.score - a.score || a.sha.localeCompare(b.sha));
}
