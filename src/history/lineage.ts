/**
 * A compact, generation-local validity-interval table.
 *
 * The table deliberately records graph edges and a deterministic topological
 * ordinal; it never derives ordinal answers from timestamps.  It is JSON
 * rather than another database because it is a small side-car index whose
 * correctness must be independently inspectable and recoverable.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { CommitExtraction, EvidenceRecord, LineageInterval, LineageStore } from '../types.js';
import { LINEAGE_SCHEMA_VERSION } from '../types.js';
import { pathMatchKeys } from './pathkeys.js';

/**
 * Minimum inverse-document-frequency weight for a path to link commits at all.
 * A path touched by nearly every commit falls below this and contributes
 * nothing, but the cutoff is on distinctiveness rather than a flat fraction of
 * repository size, which is what broke on monorepos.
 */
const MIN_PATH_LINK_WEIGHT = 0.25;

/** Most distinctive paths of a seed that may produce links. */
const MAX_SEED_PATHS = 6;

/** Ceiling on path-derived links, so a shared file cannot flood the pool. */
const MAX_PATH_LINKS = 400;

const MAX_TOKENS_PER_COMMIT = 256;
/**
 * Identifier-like tokens.
 *
 * Two shapes are accepted. Three-or-more characters starting with a letter or
 * underscore is the ordinary case. Short letter+digit mixes (`h3`, `h2`, `v2`,
 * `ip6`) are accepted at two characters because they are the most specific
 * terms a protocol or version question can key on, and a flat three-character
 * floor silently discarded exactly those: "when was HTTP/3 support first
 * introduced" lost `h3` -- curl's actual identifier for the feature -- and
 * fell back to `http`, which most of the history touches.
 *
 * Pure two-letter words are still excluded; the digit is what makes a short
 * token specific rather than noise.
 */
const TOKEN_RE = /[A-Za-z_][A-Za-z0-9_]{2,}|[A-Za-z]+[0-9]+/g;

export interface LineageEvent {
  readonly sha: string;
  readonly parents: readonly string[];
  readonly committerTime: number;
  readonly subject: string;
  readonly paths: readonly string[];
  readonly additions: readonly string[];
  readonly removals: readonly string[];
  readonly ranges: readonly { path: string; start: number | null; end: number | null }[];
}

interface LineageFile {
  readonly schemaVersion: number;
  readonly events: readonly LineageEvent[];
}

function tokens(text: string): string[] {
  const result = new Set<string>();
  for (const word of text.match(TOKEN_RE) ?? []) {
    result.add(word.toLowerCase());
    if (result.size >= MAX_TOKENS_PER_COMMIT) break;
  }
  return [...result].sort();
}

function diffTokens(evidence: EvidenceRecord[]): { additions: string[]; removals: string[] } {
  const additions = new Set<string>();
  const removals = new Set<string>();
  for (const item of evidence) {
    if (item.kind !== 'hunk') continue;
    for (const line of item.sourceExcerpt.split('\n')) {
      const target =
        line.startsWith('+') && !line.startsWith('+++')
          ? additions
          : line.startsWith('-') && !line.startsWith('---')
            ? removals
            : null;
      if (target === null) continue;
      for (const token of tokens(line.slice(1))) {
        target.add(token);
        if (target.size >= MAX_TOKENS_PER_COMMIT) break;
      }
    }
  }
  return { additions: [...additions].sort(), removals: [...removals].sort() };
}

/** Convert the extraction boundary into durable, bounded temporal facts. */
export function lineageEventFromExtraction(extraction: CommitExtraction): LineageEvent {
  const pathSet = new Set<string>();
  for (const change of extraction.commit.changedPaths) {
    for (const key of pathMatchKeys(change.path.display)) pathSet.add(key);
    if (change.oldPath !== null)
      for (const key of pathMatchKeys(change.oldPath.display)) pathSet.add(key);
  }
  const ranges = extraction.evidence
    .filter((e) => e.kind === 'hunk')
    .map((e) => ({
      path: e.path.display,
      start: e.newStart ?? e.oldStart,
      end:
        e.newStart === null && e.oldStart === null
          ? null
          : (e.newStart ?? e.oldStart ?? 0) + Math.max(e.newCount ?? 0, e.oldCount ?? 0),
    }));
  const changes = diffTokens([...extraction.evidence]);
  return {
    sha: extraction.commit.sha,
    parents: extraction.commit.parents,
    committerTime: extraction.commit.committerTime,
    subject: extraction.commit.subject,
    paths: [...pathSet].sort(),
    ...changes,
    ranges,
  };
}

function topo(events: readonly LineageEvent[]): Map<string, number> {
  const bySha = new Map(events.map((event) => [event.sha, event]));
  const indegree = new Map(events.map((event) => [event.sha, 0]));
  const children = new Map<string, string[]>();
  for (const event of events)
    for (const parent of event.parents) {
      if (!bySha.has(parent)) continue;
      indegree.set(event.sha, (indegree.get(event.sha) ?? 0) + 1);
      const list = children.get(parent) ?? [];
      list.push(event.sha);
      children.set(parent, list);
    }
  const ready = [...indegree]
    .filter(([, count]) => count === 0)
    .map(([sha]) => sha)
    .sort();
  const out = new Map<string, number>();
  while (ready.length > 0) {
    const sha = ready.shift()!;
    out.set(sha, out.size);
    for (const child of children.get(sha) ?? []) {
      const count = (indegree.get(child) ?? 1) - 1;
      indegree.set(child, count);
      if (count === 0) {
        ready.push(child);
        ready.sort();
      }
    }
  }
  for (const sha of [...bySha.keys()].sort()) if (!out.has(sha)) out.set(sha, out.size);
  return out;
}

function interval(
  key: string,
  kind: LineageInterval['kind'],
  additions: readonly LineageEvent[],
  removals: readonly LineageEvent[],
  order: ReadonlyMap<string, number>,
): LineageInterval {
  const sort = (events: readonly LineageEvent[]) =>
    [...events].sort(
      (a, b) => (order.get(a.sha) ?? 0) - (order.get(b.sha) ?? 0) || a.sha.localeCompare(b.sha),
    );
  const added = sort(additions);
  const removed = sort(removals);
  const chain = sort([
    ...new Map([...added, ...removed].map((event) => [event.sha, event])).values(),
  ]).map((event) => event.sha);
  return {
    key,
    kind,
    firstAddedSha: added[0]?.sha ?? null,
    lastAddedSha: added.at(-1)?.sha ?? null,
    firstRemovedSha: removed[0]?.sha ?? null,
    lastRemovedSha: removed.at(-1)?.sha ?? null,
    chain,
  };
}

export function buildIntervals(events: readonly LineageEvent[]): {
  tokens: Map<string, LineageInterval>;
  paths: Map<string, LineageInterval>;
} {
  const order = topo(events);
  const tokenAdds = new Map<string, LineageEvent[]>();
  const tokenRemoves = new Map<string, LineageEvent[]>();
  const pathTouches = new Map<string, LineageEvent[]>();
  const add = (map: Map<string, LineageEvent[]>, key: string, event: LineageEvent) => {
    const list = map.get(key) ?? [];
    list.push(event);
    map.set(key, list);
  };
  for (const event of events) {
    for (const token of event.additions) add(tokenAdds, token, event);
    for (const token of event.removals) add(tokenRemoves, token, event);
    for (const key of event.paths) add(pathTouches, key, event);
  }
  const tokens = new Map<string, LineageInterval>();
  const paths = new Map<string, LineageInterval>();
  for (const key of new Set([...tokenAdds.keys(), ...tokenRemoves.keys()]))
    tokens.set(
      key,
      interval(key, 'token', tokenAdds.get(key) ?? [], tokenRemoves.get(key) ?? [], order),
    );
  for (const [key, touched] of pathTouches)
    paths.set(key, interval(key, 'path', touched, [], order));
  return { tokens, paths };
}

function readFile(file: string): LineageFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as LineageFile;
    return parsed.schemaVersion === LINEAGE_SCHEMA_VERSION && Array.isArray(parsed.events)
      ? parsed
      : { schemaVersion: LINEAGE_SCHEMA_VERSION, events: [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { schemaVersion: LINEAGE_SCHEMA_VERSION, events: [] };
    throw error;
  }
}

/** Merge exact SHA replacements and atomically persist the sidecar. */
export function writeLineageEvents(file: string, updates: readonly LineageEvent[]): void {
  const previous = readFile(file);
  const events = new Map(previous.events.map((event) => [event.sha, event]));
  for (const event of updates) events.set(event.sha, event);
  const payload: LineageFile = {
    schemaVersion: LINEAGE_SCHEMA_VERSION,
    events: [...events.values()].sort((a, b) => a.sha.localeCompare(b.sha)),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, JSON.stringify(payload));
  fs.renameSync(temp, file);
}

/** Drop unreachable history only after the primary index has pruned it. */
export function pruneLineageEvents(file: string, reachable: ReadonlySet<string>): void {
  const previous = readFile(file);
  const retained = previous.events.filter((event) => reachable.has(event.sha));
  if (retained.length === previous.events.length) return;
  const payload: LineageFile = { schemaVersion: LINEAGE_SCHEMA_VERSION, events: retained };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, JSON.stringify(payload));
  fs.renameSync(temp, file);
}

export class JsonLineageStore implements LineageStore {
  readonly #events: readonly LineageEvent[];
  #pathCountCache: ReadonlyMap<string, number> | null = null;
  readonly #intervals: ReturnType<typeof buildIntervals>;
  constructor(private readonly file: string) {
    this.#events = readFile(file).events;
    this.#intervals = buildIntervals(this.#events);
  }
  async lookupToken(token: string): Promise<LineageInterval | null> {
    return this.#intervals.tokens.get(token.toLowerCase()) ?? null;
  }
  async lookupPath(pathKey: string): Promise<LineageInterval | null> {
    return this.#intervals.paths.get(pathKey) ?? null;
  }
  /**
   * Path keys touched by so many commits that linking through them says
   * nothing. A changelog, a version header or a docs directory is edited by a
   * large fraction of the history, so "shares a path with the seed" stops
   * being evidence of a relationship and starts being evidence of nothing.
   *
   * Linking through them pulled hundreds of unrelated commits into the
   * candidate pool on curl and drowned the real seeds. The cutoff is a
   * document frequency rather than a name list, because which paths are hot is
   * a property of each repository, not something that can be enumerated ahead
   * of time.
   */
  /**
   * How many commits touch each path key.
   *
   * Used to weight links by rarity rather than to exclude. A flat cutoff --
   * "hot" meant touched by more than 2% of commits -- was catastrophic on a
   * monorepo: 2% of zod's 3,210 commits is 64, and its main source files are
   * edited far more often than that, so EVERY candidate path was hot, nothing
   * linked, and structural expansion returned zero results on every query it
   * was ever asked. The filter meant to suppress noise suppressed the feature.
   */
  #pathCounts(): ReadonlyMap<string, number> {
    if (this.#pathCountCache !== null) return this.#pathCountCache;
    const counts = new Map<string, number>();
    for (const event of this.#events) {
      for (const key of new Set(event.paths)) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    this.#pathCountCache = counts;
    return counts;
  }

  /**
   * Link strength for sharing a path, by inverse document frequency.
   *
   * Sharing a rarely-touched path is strong evidence two commits are related;
   * sharing a file everyone edits is almost none. Weighting expresses that as
   * a gradient instead of a cliff, so a path stops mattering gradually as it
   * becomes common and no path is ever silently removed from consideration.
   */
  #pathWeight(key: string): number {
    const total = this.#events.length || 1;
    const touching = this.#pathCounts().get(key) ?? 1;
    // 1 for a path touched once; approaches 0 as it approaches ubiquity.
    return Math.log(1 + total / touching) / Math.log(1 + total);
  }

  async linkedCommits(sha: string, maxHops: number): Promise<ReadonlyMap<string, number>> {
    const seed = this.#events.find((event) => event.sha === sha);
    if (seed === undefined || maxHops < 1) return new Map();
    const result = new Map<string, number>();

    // Keep the seed's most distinctive paths and require a minimum strength,
    // rather than excluding everything above a fixed frequency. On a monorepo
    // the fixed rule removed every path and expansion never produced a single
    // linked commit.
    const seedPaths = [...new Set(seed.paths)]
      .map((key) => ({ key, weight: this.#pathWeight(key) }))
      .filter((p) => p.weight >= MIN_PATH_LINK_WEIGHT)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, MAX_SEED_PATHS);
    const pathSet = new Set(seedPaths.map((p) => p.key));

    if (pathSet.size > 0) {
      for (const event of this.#events) {
        if (event.sha === sha || !event.paths.some((key) => pathSet.has(key))) continue;
        result.set(event.sha, 1);
        if (result.size >= MAX_PATH_LINKS) break;
      }
    }
    for (const token of [...seed.additions, ...seed.removals])
      for (const endpoint of [
        this.#intervals.tokens.get(token)?.firstAddedSha,
        this.#intervals.tokens.get(token)?.lastAddedSha,
        this.#intervals.tokens.get(token)?.firstRemovedSha,
        this.#intervals.tokens.get(token)?.lastRemovedSha,
      ])
        if (endpoint !== null && endpoint !== undefined && endpoint !== sha)
          result.set(endpoint, 1);
    return result;
  }
  async diskBytes(): Promise<number> {
    try {
      return fs.statSync(this.file).size;
    } catch {
      return 0;
    }
  }
  async close(): Promise<void> {}
}
