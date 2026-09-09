/**
 * The Zvec physical schema for one history generation, and the
 * `HistoryStore` implementation from `src/types.ts` (spec section 8).
 *
 * Physical schema flattens the conceptual `CommitRecord`/`EvidenceRecord`
 * contracts: nonscalar payloads (parents, changedPaths, coverage, ...) are
 * encoded as a single JSON `payload` string rather than assumed-scalar
 * objects (Zvec scalar fields are primitives, arrays of primitives, or
 * typed arrays — see `node_modules/@zvec/zvec/src/index.d.ts`). Only the
 * fields actually needed for eligibility are indexed scalars; embeddings
 * are never included in `outputFields` for search/status/JSON paths.
 */

import fs from 'node:fs';
import {
  ZVecCreateAndOpen,
  ZVecOpen,
  ZVecCollectionSchema,
  ZVecDataType,
  ZVecIndexType,
  ZVecMetricType,
  isZVecError,
} from '@zvec/zvec';
import type { ZVecCollection, ZVecCollectionOptions, ZVecDocInput } from '@zvec/zvec';
import type {
  CommitRecord,
  EvidenceRecord,
  ScoredRecord,
  StorageFilter,
  HistoryStore,
} from '../types.js';
import { GitWhyError } from '../types.js';
import {
  buildEligibilityExpression,
  pathMatchKeys,
  quoteFilterLiteral,
  stripQuotesForIndexing,
  type EligibilityFieldNames,
} from './filter.js';

export const HISTORY_COLLECTION_NAME = 'git_why_history_v1';

/**
 * Identifies OUR physical schema/layout contract (field names, types,
 * index choices in this file) — independent of the installed `@zvec/zvec`
 * package's own semver, since what actually governs compatibility across a
 * git-why upgrade is whether this module's schema shape changed. Bump this
 * whenever `historyCollectionSchema` changes in an incompatible way.
 */
export const DATABASE_FORMAT_COMPATIBILITY = 'git-why-zvec-schema-v1';

const FIELD = {
  type: 'rtype',
  sha: 'sha',
  committerTime: 'committerTime',
  authorSearch: 'authorSearch',
  pathKeys: 'pathKeys',
  lexicalText: 'lexicalText',
  payload: 'payload',
} as const;

const VECTOR_FIELD = 'embedding';

const ELIGIBILITY_FIELDS: EligibilityFieldNames = {
  type: FIELD.type,
  committerTime: FIELD.committerTime,
  authorSearch: FIELD.authorSearch,
  pathKeys: FIELD.pathKeys,
};

/** Records with more path/array entries than this are truncated deterministically for the eligibility index only; the full catalog lives in the JSON payload. */
const MAX_PATH_MATCH_KEYS = 4096;

export type VectorIndexKind = 'flat' | 'hnsw';

export interface HistoryCollectionConfig {
  readonly embeddingDimension: number;
  /** Spec section 14: start with the simplest suitable index. Default FLAT. */
  readonly vectorIndex?: VectorIndexKind;
}

export function historyCollectionSchema(config: HistoryCollectionConfig): ZVecCollectionSchema {
  const vectorIndexParams =
    config.vectorIndex === 'hnsw'
      ? ({ indexType: ZVecIndexType.HNSW, metricType: ZVecMetricType.COSINE } as const)
      : ({ indexType: ZVecIndexType.FLAT, metricType: ZVecMetricType.COSINE } as const);
  return new ZVecCollectionSchema({
    name: HISTORY_COLLECTION_NAME,
    fields: [
      {
        name: FIELD.type,
        dataType: ZVecDataType.STRING,
        indexParams: { indexType: ZVecIndexType.INVERT },
      },
      {
        name: FIELD.sha,
        dataType: ZVecDataType.STRING,
        indexParams: { indexType: ZVecIndexType.INVERT },
      },
      {
        name: FIELD.committerTime,
        dataType: ZVecDataType.INT64,
        indexParams: { indexType: ZVecIndexType.INVERT },
      },
      {
        name: FIELD.authorSearch,
        dataType: ZVecDataType.STRING,
        indexParams: { indexType: ZVecIndexType.INVERT },
      },
      {
        name: FIELD.pathKeys,
        dataType: ZVecDataType.ARRAY_STRING,
        indexParams: { indexType: ZVecIndexType.INVERT },
      },
      {
        name: FIELD.lexicalText,
        dataType: ZVecDataType.STRING,
        indexParams: {
          indexType: ZVecIndexType.FTS,
          tokenizerName: 'standard',
          filters: ['lowercase'],
        },
      },
      { name: FIELD.payload, dataType: ZVecDataType.STRING },
    ],
    vectors: [
      {
        name: VECTOR_FIELD,
        dataType: ZVecDataType.VECTOR_FP32,
        dimension: config.embeddingDimension,
        indexParams: vectorIndexParams,
      },
    ],
  });
}

/** Opens an existing collection at `collectionDir`, or creates it if absent. */
export function openOrCreateHistoryCollection(
  collectionDir: string,
  config: HistoryCollectionConfig,
  options?: ZVecCollectionOptions,
): ZVecCollection {
  // The native binding rejects an explicit `undefined` options argument
  // (`CreateAndOpen(): argument 'options' must be a CollectionOptions
  // object`) — it must be omitted entirely rather than passed as
  // `undefined`, so the argument is never forwarded when absent.
  if (fs.existsSync(collectionDir)) {
    try {
      return options !== undefined ? ZVecOpen(collectionDir, options) : ZVecOpen(collectionDir);
    } catch (err) {
      if (isZVecError(err) && err.code === 'ZVEC_NOT_FOUND') {
        return options !== undefined
          ? ZVecCreateAndOpen(collectionDir, historyCollectionSchema(config), options)
          : ZVecCreateAndOpen(collectionDir, historyCollectionSchema(config));
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new GitWhyError(
        'STORAGE_FAILED',
        `failed to open history collection at ${collectionDir}: ${message}`,
        { cause: err },
      );
    }
  }
  return options !== undefined
    ? ZVecCreateAndOpen(collectionDir, historyCollectionSchema(config), options)
    : ZVecCreateAndOpen(collectionDir, historyCollectionSchema(config));
}

function boundedUniqueKeys(keys: Iterable<string>): string[] {
  const set = new Set<string>();
  for (const key of keys) {
    set.add(key);
    if (set.size >= MAX_PATH_MATCH_KEYS) break;
  }
  return [...set];
}

function authorSearchValue(author: { readonly name: string; readonly email: string }): string {
  return stripQuotesForIndexing(`${author.name} <${author.email}>`.toLowerCase());
}

export interface CommitDocInput {
  readonly record: CommitRecord;
  readonly vector: Float32Array;
}

export interface EvidenceDocInput {
  readonly record: EvidenceRecord;
  /** Evidence records do not carry committer time or author; the owning commit's are denormalized in for eligibility filtering. */
  readonly committerTime: number;
  readonly author: { readonly name: string; readonly email: string };
  readonly vector: Float32Array;
}

export function buildCommitDoc(input: CommitDocInput): ZVecDocInput {
  const { record, vector } = input;
  const keys = boundedUniqueKeys(
    record.changedPaths.flatMap((change) => [
      ...pathMatchKeys(change.path.display),
      ...(change.oldPath !== null ? pathMatchKeys(change.oldPath.display) : []),
    ]),
  );
  return {
    id: record.id,
    fields: {
      [FIELD.type]: 'commit',
      [FIELD.sha]: record.sha,
      [FIELD.committerTime]: record.committerTime,
      [FIELD.authorSearch]: authorSearchValue(record.author),
      [FIELD.pathKeys]: keys,
      [FIELD.lexicalText]: record.lexicalText,
      [FIELD.payload]: JSON.stringify(record),
    },
    vectors: { [VECTOR_FIELD]: vector },
  };
}

export function buildEvidenceDoc(input: EvidenceDocInput): ZVecDocInput {
  const { record, vector, committerTime, author } = input;
  const keys = boundedUniqueKeys([
    ...pathMatchKeys(record.path.display),
    ...(record.oldPath !== null ? pathMatchKeys(record.oldPath.display) : []),
  ]);
  return {
    id: record.id,
    fields: {
      [FIELD.type]: 'evidence',
      [FIELD.sha]: record.sha,
      [FIELD.committerTime]: committerTime,
      [FIELD.authorSearch]: authorSearchValue(author),
      [FIELD.pathKeys]: keys,
      [FIELD.lexicalText]: record.lexicalText,
      [FIELD.payload]: JSON.stringify(record),
    },
    vectors: { [VECTOR_FIELD]: vector },
  };
}

interface RawZVecDoc {
  readonly id: string;
  readonly score: number;
  readonly fields: Record<string, unknown>;
}

/**
 * Zvec's COSINE metric returns a DISTANCE: lower is closer. `ScoredRecord.score`
 * is defined as "higher is better" and the ranking layer sorts on it that way,
 * so the vector branch must be converted at this boundary. Leaving it as a raw
 * distance silently ranks the least relevant commits first, which is not
 * visible as an error anywhere downstream — only as bad results.
 */
function similarityFromCosineDistance(distance: number): number {
  return 1 - distance;
}

function toScoredRecord(
  doc: RawZVecDoc,
  transform: (score: number) => number = (x) => x,
): ScoredRecord {
  const type = doc.fields[FIELD.type];
  const sha = doc.fields[FIELD.sha];
  if (type !== 'commit' && type !== 'evidence') {
    throw new GitWhyError(
      'INDEX_CORRUPT',
      `document ${doc.id} has an invalid record type: ${String(type)}`,
    );
  }
  if (typeof sha !== 'string') {
    throw new GitWhyError('INDEX_CORRUPT', `document ${doc.id} is missing its sha field`);
  }
  return { id: doc.id, type, sha, score: transform(doc.score) };
}

function parsePayload<T>(doc: RawZVecDoc): T {
  const payload = doc.fields[FIELD.payload];
  if (typeof payload !== 'string') {
    throw new GitWhyError('INDEX_CORRUPT', `document ${doc.id} is missing its payload field`);
  }
  try {
    return JSON.parse(payload) as T;
  } catch (err) {
    throw new GitWhyError('INDEX_CORRUPT', `document ${doc.id} has an unparsable payload`, {
      cause: err,
    });
  }
}

/** The `HistoryStore` boundary (`src/types.ts`) implemented against a real Zvec collection. */
export class ZvecHistoryStore implements HistoryStore {
  private readonly collection: ZVecCollection;

  constructor(collection: ZVecCollection) {
    this.collection = collection;
  }

  private eligibilityFilter(filter: StorageFilter): string | undefined {
    return buildEligibilityExpression(ELIGIBILITY_FIELDS, filter.recordTypes, filter.filters);
  }

  async searchLexical(
    queryText: string,
    filter: StorageFilter,
    topK: number,
  ): Promise<readonly ScoredRecord[]> {
    const docs = this.collection.querySync({
      fieldName: FIELD.lexicalText,
      // Never `queryString`: arbitrary user text is not trusted query-parser syntax (docs/decisions.md section 2).
      fts: { matchString: queryText },
      filter: this.eligibilityFilter(filter),
      topk: topK,
      includeVector: false,
      outputFields: [FIELD.type, FIELD.sha],
    });
    return docs.map((d) => toScoredRecord(d as unknown as RawZVecDoc));
  }

  async searchSemantic(
    queryVector: Float32Array,
    filter: StorageFilter,
    topK: number,
  ): Promise<readonly ScoredRecord[]> {
    const docs = this.collection.querySync({
      fieldName: VECTOR_FIELD,
      vector: queryVector,
      filter: this.eligibilityFilter(filter),
      topk: topK,
      includeVector: false,
      outputFields: [FIELD.type, FIELD.sha],
    });
    return docs.map((d) =>
      toScoredRecord(d as unknown as RawZVecDoc, similarityFromCosineDistance),
    );
  }

  async fetchCommits(shas: readonly string[]): Promise<ReadonlyMap<string, CommitRecord>> {
    const map = new Map<string, CommitRecord>();
    if (shas.length === 0) return map;
    const expr = `${FIELD.type} = 'commit' AND ${FIELD.sha} IN (${shas.map((s) => quoteFilterLiteral(s)).join(', ')})`;
    const docs = this.collection.querySync({
      filter: expr,
      topk: shas.length,
      includeVector: false,
      outputFields: [FIELD.payload],
    });
    for (const doc of docs) {
      const record = parsePayload<CommitRecord>(doc as unknown as RawZVecDoc);
      map.set(record.sha, record);
    }
    return map;
  }

  async fetchEvidence(ids: readonly string[]): Promise<ReadonlyMap<string, EvidenceRecord>> {
    const map = new Map<string, EvidenceRecord>();
    if (ids.length === 0) return map;
    const docs = this.collection.fetchSync({
      ids: [...ids],
      includeVector: false,
      outputFields: [FIELD.payload],
    });
    for (const [id, doc] of Object.entries(docs)) {
      map.set(id, parsePayload<EvidenceRecord>({ id, score: doc.score, fields: doc.fields }));
    }
    return map;
  }

  async evidenceForCommit(
    sha: string,
    filter: StorageFilter,
    limit: number,
  ): Promise<readonly EvidenceRecord[]> {
    const eligibility = buildEligibilityExpression(
      ELIGIBILITY_FIELDS,
      ['evidence'],
      filter.filters,
    );
    const shaClause = `${FIELD.sha} = ${quoteFilterLiteral(sha)}`;
    const expr = eligibility !== undefined ? `${shaClause} AND ${eligibility}` : shaClause;
    const docs = this.collection.querySync({
      filter: expr,
      topk: limit,
      includeVector: false,
      outputFields: [FIELD.payload],
    });
    return docs.map((doc) => parsePayload<EvidenceRecord>(doc as unknown as RawZVecDoc));
  }

  async close(): Promise<void> {
    this.collection.closeSync();
  }

  /** Not part of `HistoryStore` — used by `status.ts` and `journal.ts`, which need raw collection access. */
  get raw(): ZVecCollection {
    return this.collection;
  }
}
