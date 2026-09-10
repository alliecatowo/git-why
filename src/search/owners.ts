/**
 * Who established an area of the code, by accumulated relevance.
 *
 * `git blame` answers "who touched this line last", which a formatting sweep
 * rewrites wholesale. `git shortlog` answers "who committed most often", which
 * rewards mechanical churn. Neither looks at what the commits were about, so
 * on a file with hundreds of commits both point at whoever was most recently
 * or most frequently busy rather than whoever built the thing.
 *
 * Ownership is computed instead from the commits a search actually surfaced,
 * weighted by their ranking scores. A commit that defined a subsystem carries
 * more weight than thirty that renamed a variable inside it, because relevance
 * is what ranked it there.
 */

import type { AuthorStake, CommitHit } from '../types.js';

/** Commits kept per author in the output, so a reader can check the claim. */
const TOP_COMMITS_PER_AUTHOR = 3;

/**
 * Identity is the email, lowercased, because the display name is inconsistent
 * across a long history ("Jane Doe", "jane", "Jane D.") while the address
 * usually is not. The most recently used display name is reported.
 */
function identityKey(hit: CommitHit): string {
  return hit.author.email.trim().toLowerCase();
}

export function aggregateOwners(hits: readonly CommitHit[], limit = 5): AuthorStake[] {
  const byAuthor = new Map<
    string,
    {
      name: string;
      email: string;
      weight: number;
      commits: number;
      firstTime: number;
      lastTime: number;
      nameAt: number;
      all: { sha: string; subject: string; committerTime: number; score: number }[];
    }
  >();

  for (const hit of hits) {
    const key = identityKey(hit);
    const existing = byAuthor.get(key);
    const entry = existing ?? {
      name: hit.author.name,
      email: hit.author.email,
      weight: 0,
      commits: 0,
      firstTime: hit.committerTime,
      lastTime: hit.committerTime,
      nameAt: hit.committerTime,
      all: [],
    };
    entry.weight += hit.rankScore;
    entry.commits += 1;
    entry.firstTime = Math.min(entry.firstTime, hit.committerTime);
    entry.lastTime = Math.max(entry.lastTime, hit.committerTime);
    // Prefer the most recent spelling of the name.
    if (hit.committerTime >= entry.nameAt) {
      entry.name = hit.author.name;
      entry.nameAt = hit.committerTime;
    }
    entry.all.push({
      sha: hit.sha,
      subject: hit.subject,
      committerTime: hit.committerTime,
      score: hit.rankScore,
    });
    byAuthor.set(key, entry);
  }

  return [...byAuthor.values()]
    .sort((a, b) => b.weight - a.weight || b.commits - a.commits || a.email.localeCompare(b.email))
    .slice(0, limit)
    .map((entry) => ({
      name: entry.name,
      email: entry.email,
      weight: entry.weight,
      commits: entry.commits,
      firstTime: entry.firstTime,
      lastTime: entry.lastTime,
      topCommits: entry.all
        .sort((a, b) => b.score - a.score || a.sha.localeCompare(b.sha))
        .slice(0, TOP_COMMITS_PER_AUTHOR)
        .map(({ sha, subject, committerTime }) => ({ sha, subject, committerTime })),
    }));
}
