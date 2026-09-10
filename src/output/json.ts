/**
 * The versioned `--json` envelope. Strings here are JSON-escaped, never
 * sanitized: escaping keeps the data valid and round-trippable, whereas
 * `output/human.ts`'s sanitizer intentionally destroys the escaped bytes to
 * protect a terminal. See `schema/search-response.schema.json` and
 * `schema/status-response.schema.json` for the shapes produced here.
 */

import {
  JSON_SCHEMA_VERSION,
  type EvidenceHit,
  type GitWhyErrorCode,
  type IndexStatus,
  type SearchResponse,
  type ResolvedAnchor,
} from '../types.js';

export interface JsonRenderOptions {
  readonly maxBytes: number;
}

export interface JsonRenderResult {
  readonly text: string;
  readonly outputTruncated: boolean;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function evidenceToJson(ev: EvidenceHit): JsonValue {
  const out: { [key: string]: JsonValue } = {
    recordId: ev.recordId,
    kind: ev.kind,
    path: ev.path.display,
    oldPath: ev.oldPath ? ev.oldPath.display : null,
    changeType: ev.changeType,
    oldStart: ev.oldStart,
    oldCount: ev.oldCount,
    newStart: ev.newStart,
    newCount: ev.newCount,
    excerpt: ev.excerpt,
    truncated: ev.truncated,
    omissionReasons: [...ev.omissionReasons],
  };
  if (ev.path.lossy) out.pathBytesBase64 = ev.path.bytesBase64;
  if (ev.oldPath?.lossy) out.oldPathBytesBase64 = ev.oldPath.bytesBase64;
  return out;
}

/** A resolved anchor flattened for the envelope; null when there is no anchor. */
function anchorToJson(resolved: ResolvedAnchor | null): JsonValue {
  if (resolved === null) return null;
  return {
    kind: resolved.anchor.kind,
    raw: resolved.anchor.raw,
    sha: resolved.sha,
    epochSeconds: resolved.epochSeconds,
  };
}

function buildEnvelope(
  response: SearchResponse,
  outputTruncated: boolean,
): { [key: string]: JsonValue } {
  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    query: response.query,
    coreQuery: response.coreQuery,
    mode: response.mode,
    sort: response.sort,
    snapshot: {
      scope: response.snapshot.scope,
      fingerprint: response.snapshot.fingerprint,
      indexedAt: response.snapshot.indexedAt,
      freshness: response.snapshot.freshness,
      coverage: response.snapshot.coverage,
      generation: response.snapshot.generation,
    },
    results: response.results.map((hit) => ({
      sha: hit.sha,
      subject: hit.subject,
      author: { name: hit.author.name, email: hit.author.email },
      authorTime: hit.authorTime,
      committerTime: hit.committerTime,
      parents: [...hit.parents],
      messageExcerpt: hit.messageExcerpt,
      rankScore: hit.rankScore,
      scores: {
        fused: hit.scores.fused,
        temporal: hit.scores.temporal,
        final: hit.scores.final,
      },
      matchedBy: [...hit.matchedBy],
      linkDistance: hit.linkDistance,
      evidence: hit.evidence.map(evidenceToJson),
    })),
    temporal: {
      intent: response.temporal.intent,
      confidence: response.temporal.confidence,
      anchor: anchorToJson(response.temporal.anchor),
      anchorEnd: anchorToJson(response.temporal.anchorEnd),
      w: response.temporal.w,
    },
    answer:
      response.answer === null
        ? null
        : {
            sha: response.answer.sha,
            kind: response.answer.kind,
            viaToken: response.answer.viaToken,
            viaPath: response.answer.viaPath,
            confidence: response.answer.confidence,
          },
    owners:
      response.owners === null
        ? null
        : response.owners.map((o) => ({
            name: o.name,
            email: o.email,
            weight: o.weight,
            commits: o.commits,
            firstTime: o.firstTime,
            lastTime: o.lastTime,
            topCommits: o.topCommits.map((c) => ({
              sha: c.sha,
              subject: c.subject,
              committerTime: c.committerTime,
            })),
          })),
    timeline:
      response.timeline === null
        ? null
        : response.timeline.map((episode) => ({
            sha: episode.sha,
            kind: episode.kind,
            committerTime: episode.committerTime,
            subject: episode.subject,
            evidence: episode.evidence === null ? null : evidenceToJson(episode.evidence),
          })),
    warnings: [...response.warnings],
    outputTruncated,
    candidateLimitReached: response.candidateLimitReached,
  };
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value, null, 2), 'utf8');
}

const TRUNCATION_WARNING = 'Output truncated to fit --max-bytes; dropped evidence and/or results.';

/**
 * Renders the success envelope, degrading gracefully under `maxBytes`: drop
 * evidence entries, then whole results, then (as a last resort) shorten the
 * query text. Always returns a syntactically valid, single JSON object.
 */
export function renderSearchJson(
  response: SearchResponse,
  options: JsonRenderOptions,
): JsonRenderResult {
  let outputTruncated = false;
  const results = response.results.map((hit) => ({ ...hit, evidence: [...hit.evidence] }));
  let warnings = [...response.warnings];

  const current = () => buildEnvelope({ ...response, results, warnings }, outputTruncated);
  let envelope = current();

  while (byteLength(envelope) > options.maxBytes) {
    let mutated = false;

    for (let i = results.length - 1; i >= 0; i -= 1) {
      const hit = results[i];
      if (hit !== undefined && hit.evidence.length > 0) {
        hit.evidence.pop();
        mutated = true;
        break;
      }
    }

    if (!mutated && results.length > 0) {
      results.pop();
      mutated = true;
    }

    if (mutated) {
      outputTruncated = true;
      if (!warnings.includes(TRUNCATION_WARNING)) warnings = [...warnings, TRUNCATION_WARNING];
      envelope = current();
      continue;
    }

    // Last resort: nothing left to drop but the envelope (with zero
    // results) still doesn't fit, e.g. an extremely small --max-bytes with
    // a long query. Shorten the query text rather than emit invalid JSON.
    const query = String(envelope.query ?? '');
    if (query.length > 8) {
      envelope = {
        ...envelope,
        query: query.slice(0, Math.max(1, Math.floor(query.length / 2))) + '…',
      };
      outputTruncated = true;
      envelope = { ...envelope, outputTruncated: true };
      continue;
    }

    // Cannot shrink further; emit what we have. This should not happen
    // given the CLI's --max-bytes floor (512 bytes).
    break;
  }

  return { text: JSON.stringify(envelope, null, 2), outputTruncated };
}

export interface JsonErrorInput {
  readonly query: string;
  readonly mode: SearchResponse['mode'];
  /** Defaults to 'relevance' because a failure can occur before --sort is parsed. */
  readonly sort?: SearchResponse['sort'];
  readonly code: GitWhyErrorCode;
  readonly message: string;
  readonly hint: string | undefined;
}

/** The failure form of the search envelope: same schema version, empty results. */
export function renderSearchErrorJson(input: JsonErrorInput): string {
  const envelope: { [key: string]: JsonValue } = {
    schemaVersion: JSON_SCHEMA_VERSION,
    query: input.query,
    coreQuery: input.query,
    mode: input.mode,
    sort: input.sort ?? 'relevance',
    snapshot: null,
    results: [],
    temporal: {
      intent: 'none',
      confidence: 'inferred',
      anchor: null,
      anchorEnd: null,
      w: 0,
    },
    answer: null,
    timeline: null,
    owners: null,
    warnings: [],
    outputTruncated: false,
    candidateLimitReached: false,
    error: { code: input.code, message: input.message, hint: input.hint ?? null },
  };
  return JSON.stringify(envelope, null, 2);
}

export type LifecycleCommandName = 'index' | 'status' | 'rebuild' | 'gc';

function indexStatusToJson(status: IndexStatus): JsonValue {
  return {
    state: status.state,
    indexPath: status.indexPath,
    generation: status.generation,
    indexedCommits: status.indexedCommits,
    reachableCommits: status.reachableCommits,
    refsChanged: status.refsChanged,
    recordCount: status.recordCount,
    model: status.model
      ? {
          id: status.model.id,
          revision: status.model.revision,
          fingerprint: status.model.fingerprint,
        }
      : null,
    diskBytes: status.diskBytes,
    lineageBytes: status.lineageBytes,
    indexedAt: status.indexedAt,
    objectFormat: status.objectFormat,
    shallow: status.shallow,
    coverage: {
      excludedFiles: status.coverage.excludedFiles,
      unavailableFiles: status.coverage.unavailableFiles,
      failedFiles: status.coverage.failedFiles,
      reasons: [...status.coverage.reasons],
    },
    warnings: [...status.warnings],
  };
}

/** The status/lifecycle envelope: `schemaVersion: 1`, `command`, and a real status object. */
export function renderStatusJson(command: LifecycleCommandName, status: IndexStatus): string {
  const envelope = {
    schemaVersion: JSON_SCHEMA_VERSION,
    command,
    index: indexStatusToJson(status),
  };
  return JSON.stringify(envelope, null, 2);
}

export function renderStatusErrorJson(
  command: LifecycleCommandName,
  code: GitWhyErrorCode,
  message: string,
  hint: string | undefined,
): string {
  const envelope = {
    schemaVersion: JSON_SCHEMA_VERSION,
    command,
    index: null,
    error: { code, message, hint: hint ?? null },
  };
  return JSON.stringify(envelope, null, 2);
}
