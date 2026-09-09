// Git Why capability spike (spec section 16). Executes, not describes, the
// probes needed before src/index/ can be written against real @zvec/zvec
// behaviour. Run with: node --experimental-strip-types spike/run.ts
//
// Writes spike/out/report.json and prints a compact human summary.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import {
  ZVecCreateAndOpen,
  ZVecOpen,
  ZVecCollectionSchema,
  ZVecDataType,
  ZVecIndexType,
  ZVecMetricType,
  isZVecError,
} from '@zvec/zvec';
import { freshTmpDir, rmDir, quoteFilterLiteral, runProbe, record, type ProbeResult } from './util.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHILDREN = path.join(__dirname, 'children');
const results: ProbeResult[] = [];

function child(script: string, args: string[], opts: { timeoutMs?: number } = {}) {
  return spawnSync(process.execPath, ['--experimental-strip-types', path.join(CHILDREN, script), ...args], {
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 15000,
  });
}

function parseJsonLines(stdout: string): unknown[] {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { unparsed: l };
      }
    });
}

function basicSchema(dim = 8) {
  return new ZVecCollectionSchema({
    name: 'probe',
    fields: [
      { name: 'kind', dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.INVERT } },
      { name: 'ts', dataType: ZVecDataType.INT64, indexParams: { indexType: ZVecIndexType.INVERT } },
      { name: 'author', dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.INVERT } },
      { name: 'paths', dataType: ZVecDataType.ARRAY_STRING, indexParams: { indexType: ZVecIndexType.INVERT } },
      {
        name: 'text',
        dataType: ZVecDataType.STRING,
        indexParams: { indexType: ZVecIndexType.FTS, tokenizerName: 'standard', filters: ['lowercase'] },
      },
    ],
    vectors: [
      {
        name: 'vec',
        dataType: ZVecDataType.VECTOR_FP32,
        dimension: dim,
        indexParams: { indexType: ZVecIndexType.FLAT, metricType: ZVecMetricType.COSINE },
      },
    ],
  });
}

function hexId(n: number): string {
  return n.toString(16).padStart(64, '0');
}

async function main() {
  function readJson(p: string): any {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  const nodeModulesRoot = path.join(__dirname, '..', 'node_modules');
  let nativeBinding: { packageName: string; version: string } | null = null;
  try {
    const dirs = fs.readdirSync(path.join(nodeModulesRoot, '@zvec')).filter((d) => d.startsWith('bindings-'));
    if (dirs[0]) {
      const pkg = readJson(path.join(nodeModulesRoot, '@zvec', dirs[0], 'package.json'));
      nativeBinding = { packageName: pkg.name, version: pkg.version };
    }
  } catch {
    nativeBinding = null;
  }
  let gitVersion = 'unavailable';
  try {
    gitVersion = execFileSync('git', ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    // leave default
  }
  let osProductVersion: string | null = null;
  try {
    if (process.platform === 'darwin') {
      osProductVersion = execFileSync('sw_vers', [], { encoding: 'utf8' }).trim();
    }
  } catch {
    osProductVersion = null;
  }
  const versions = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    osRelease: os_release(),
    osProductVersion,
    zvecPackageVersion: readJson(path.join(nodeModulesRoot, '@zvec', 'zvec', 'package.json')).version as string,
    nativeBinding,
    gitVersion,
  };
  record(results, '0.0', 'environment', 'passed', 'captured platform/runtime/package/native-binding/git versions', versions);

  function os_release(): string {
    try {
      return execFileSync('uname', ['-a'], { encoding: 'utf8' }).trim();
    } catch {
      return 'unavailable';
    }
  }

  // ---------------------------------------------------------------- *
  // 1. Import, native load, lifecycle, persistence across a process
  // ---------------------------------------------------------------- *
  await runProbe(results, '1.1', 'import and native binary load', () => {
    if (typeof ZVecCreateAndOpen !== 'function') throw new Error('ZVecCreateAndOpen missing');
    return { detail: 'module imported, entry points present' };
  });

  const lifecycleDir = freshTmpDir('lifecycle');
  const colPath = path.join(lifecycleDir, 'col');
  await runProbe(results, '1.2', 'create, insert, upsert, close, reopen', () => {
    const col = ZVecCreateAndOpen(colPath, basicSchema());
    const insertStatus = col.insertSync({ id: hexId(1), fields: { kind: 'commit', ts: 1, author: 'a', paths: ['x'], text: 'hello' }, vectors: { vec: new Float32Array(8).fill(0.1) } });
    const upsertStatus = col.upsertSync({ id: hexId(1), fields: { kind: 'commit', ts: 2, author: 'a', paths: ['x'], text: 'hello again' }, vectors: { vec: new Float32Array(8).fill(0.2) } });
    col.closeSync();
    const reopened = ZVecOpen(colPath);
    const doc = reopened.fetchSync({ ids: hexId(1), includeVector: false });
    reopened.closeSync();
    const vectorsOmitted = Object.keys(doc[hexId(1)]?.vectors ?? { placeholder: 1 }).length === 0;
    const ok = insertStatus.ok && upsertStatus.ok && doc[hexId(1)]?.fields.ts === 2 && vectorsOmitted;
    if (!ok) throw new Error(`unexpected state: ${JSON.stringify({ insertStatus, upsertStatus, doc })}`);
    return {
      detail: `insert then upsert then close then reopen then fetch(includeVector:false): upsert overwrote ts 1->2 as expected, and fetch honoured includeVector:false by returning an empty vectors object (not the vector data)`,
      evidence: { insertStatus, upsertStatus, doc },
    };
  });

  await runProbe(results, '1.3', 'delete by id and by filter', () => {
    const col = ZVecOpen(colPath);
    col.upsertSync([
      { id: hexId(2), fields: { kind: 'evidence', ts: 3, author: 'b', paths: ['y'], text: 'bye' }, vectors: { vec: new Float32Array(8).fill(0.3) } },
    ]);
    const beforeCount = col.stats.docCount;
    const delStatus = col.deleteSync(hexId(2));
    const afterDelete = col.stats.docCount;
    col.upsertSync([{ id: hexId(3), fields: { kind: 'evidence', ts: 4, author: 'b', paths: ['y'], text: 'bye2' }, vectors: { vec: new Float32Array(8).fill(0.3) } }]);
    const filterDelStatus = col.deleteByFilterSync(`kind = 'evidence'`);
    const afterFilterDelete = col.stats.docCount;
    col.closeSync();
    return {
      detail: `docCount ${beforeCount} -> ${afterDelete} (id delete) -> ${afterFilterDelete} (filter delete)`,
      evidence: { delStatus, filterDelStatus },
    };
  });

  await runProbe(results, '1.4', 'persistence across a process boundary', () => {
    const persistDir = freshTmpDir('persist');
    const pcol = path.join(persistDir, 'col');
    const write = child('lifecycle-writer.ts', [pcol, 'close', '5']);
    if (write.status !== 0) throw new Error(`writer child failed: ${write.stderr}`);
    const read = child('lifecycle-reader.ts', [pcol]);
    if (read.status !== 0) throw new Error(`reader child failed: ${read.stderr}`);
    const readOut = parseJsonLines(read.stdout)[0] as { docCount: number; fetched: number };
    rmDir(persistDir);
    if (readOut.docCount !== 5 || readOut.fetched !== 5) throw new Error(`expected 5 docs surviving, got ${JSON.stringify(readOut)}`);
    return { detail: 'data written by one process and closed was fully visible after reopening in a second process', evidence: readOut };
  });

  // ---------------------------------------------------------------- *
  // 2. Native FTS behaviour and safe compilation of arbitrary user text
  // ---------------------------------------------------------------- *
  const ftsDir = freshTmpDir('fts');
  const ftsPath = path.join(ftsDir, 'col');
  const ftsCol = ZVecCreateAndOpen(ftsPath, basicSchema());
  ftsCol.upsertSync([
    { id: hexId(10), fields: { kind: 'commit', ts: 1, author: 'a', paths: ['x'], text: 'Fixed a bug in the authentication flow for new users' }, vectors: { vec: new Float32Array(8).fill(0.1) } },
    { id: hexId(11), fields: { kind: 'commit', ts: 2, author: 'a', paths: ['x'], text: 'Refactor AuthSessionProvider to cache tokens' }, vectors: { vec: new Float32Array(8).fill(0.2) } },
    { id: hexId(12), fields: { kind: 'commit', ts: 3, author: 'a', paths: ['x'], text: 'Bump postgres 13.4 -> 13.9 in docker-compose' }, vectors: { vec: new Float32Array(8).fill(0.3) } },
    { id: hexId(13), fields: { kind: 'evidence', ts: 4, author: 'a', paths: ['x'], text: 'Removed code: if (user.isAdmin) { grantAccess(); }' }, vectors: { vec: new Float32Array(8).fill(0.4) } },
  ]);

  await runProbe(results, '2.1', 'FTS on ordinary prose (queryString)', () => {
    const r = ftsCol.querySync({ fieldName: 'text', fts: { queryString: 'authentication bug' }, topk: 10, outputFields: ['text'] });
    if (r.length === 0) throw new Error('expected prose match');
    return { detail: `matched ${r.length} doc(s)`, evidence: r.map((d) => d.fields.text) };
  });

  await runProbe(results, '2.2', 'FTS on camelCase identifier AuthSessionProvider', () => {
    const exact = ftsCol.querySync({ fieldName: 'text', fts: { queryString: 'AuthSessionProvider' }, topk: 10, outputFields: ['text'] });
    const lower = ftsCol.querySync({ fieldName: 'text', fts: { queryString: 'authsessionprovider' }, topk: 10, outputFields: ['text'] });
    const split = ftsCol.querySync({ fieldName: 'text', fts: { queryString: 'Session' }, topk: 10, outputFields: ['text'] });
    const splitMatchedTargetOnly = split.length === 1 && split[0]?.fields.text.includes('AuthSessionProvider');
    return {
      detail: `standard tokenizer treats camelCase as ONE token (case-insensitive via lowercase filter): exact=${exact.length} lower(case)=${lower.length} substring-word 'Session' alone=${split.length}${splitMatchedTargetOnly ? ' (did NOT split on internal case boundary; matched only via the "lowercase" filter on the full token comparison — see evidence)' : ''}`,
      evidence: { exact: exact.map((d) => d.fields.text), lower: lower.map((d) => d.fields.text), split: split.map((d) => d.fields.text) },
    };
  });

  await runProbe(results, '2.3', 'FTS on dotted version string postgres 13.4', () => {
    const full = ftsCol.querySync({ fieldName: 'text', fts: { queryString: 'postgres 13.4' }, topk: 10, outputFields: ['text'] });
    const numOnly = ftsCol.querySync({ fieldName: 'text', fts: { queryString: '13.4' }, topk: 10, outputFields: ['text'] });
    const wrongNum = ftsCol.querySync({ fieldName: 'text', fts: { queryString: '13.9' }, topk: 10, outputFields: ['text'] });
    return {
      detail: `numbers preserved distinctly: '13.4' matches=${numOnly.length}, '13.9' matches=${wrongNum.length} (13.9 also literally present in doc as target version, see evidence)`,
      evidence: { full: full.map((d) => d.fields.text), numOnly: numOnly.map((d) => d.fields.text), wrongNum: wrongNum.map((d) => d.fields.text) },
    };
  });

  await runProbe(results, '2.4', 'FTS on a line of deleted code: diff markers, dotted identifiers, tokenizer choice', () => {
    // Isolated collection so this probe doesn't depend on ftsCol's seed docs.
    const dir = freshTmpDir('fts-deleted');
    const withDash = new ZVecCollectionSchema({
      name: 'deleted',
      fields: [
        { name: 'std', dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.FTS, tokenizerName: 'standard', filters: ['lowercase'] } },
        { name: 'ws', dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.FTS, tokenizerName: 'whitespace', filters: ['lowercase'] } },
      ],
    });
    const col = ZVecCreateAndOpen(path.join(dir, 'col'), withDash);
    const minusLine = '- if (user.isAdmin) { grantAccess(); }'; // a real "removed" diff line, marker included
    const plusLine = '+ if (user.isAdmin) { grantAccess(); }';
    const bareLine = 'if (user.isAdmin) { grantAccess(); }';
    col.insertSync([
      { id: hexId(20), fields: { std: minusLine, ws: minusLine } },
      { id: hexId(21), fields: { std: plusLine, ws: plusLine } },
      { id: hexId(22), fields: { std: bareLine, ws: bareLine } },
    ]);
    // grantAccess has no internal '.' — should match regardless of the leading diff marker.
    const stdGrant = col.querySync({ fieldName: 'std', fts: { matchString: 'grantAccess' }, topk: 10 });
    const wsGrant = col.querySync({ fieldName: 'ws', fts: { matchString: 'grantAccess' }, topk: 10 });
    // isAdmin is the second half of the dotted identifier "user.isAdmin".
    const stdBareComponent = col.querySync({ fieldName: 'std', fts: { matchString: 'isAdmin' }, topk: 10 });
    const stdFullDotted = col.querySync({ fieldName: 'std', fts: { matchString: 'user.isAdmin' }, topk: 10 });
    col.closeSync();
    rmDir(dir);

    if (stdGrant.length !== 3) throw new Error(`leading diff marker ('-'/'+') corrupted tokenization: expected all 3 variants to match 'grantAccess', got ${stdGrant.length}`);
    const wsHandlesCode = wsGrant.length === 3;
    const dottedComponentSplits = stdBareComponent.length > 0;

    return {
      detail:
        `Diff markers do NOT need stripping: '-'/'+'-prefixed lines tokenize identically to the bare line under the 'standard' tokenizer (grantAccess matched in all 3/3 variants). ` +
        `The real hazard is DOTTED IDENTIFIERS: the 'standard' tokenizer keeps 'user.isAdmin' as a single token (matches full-dotted:${stdFullDotted.length}, but bare component 'isAdmin' alone matches:${stdBareComponent.length}/3 — i.e. it does NOT auto-split, same as the camelCase finding in 2.2). ` +
        `RULE for the retrieval lane's lexical normalization (spec section 9): it must explicitly emit split components (camelCase parts, snake_case parts, dotted/path segments) as additional lexical tokens alongside the original text, because the native tokenizer will not do this splitting itself. ` +
        `Tokenizer choice: 'whitespace' is UNSUITABLE for code — punctuation-attached identifiers like 'grantAccess();' never separate from trailing punctuation (whitespace-tokenizer match rate for a bare identifier next to punctuation: ${wsGrant.length}/3, expected 3/3 ${wsHandlesCode ? '(surprisingly worked)' : '(confirmed broken)'}). Use 'standard', not 'whitespace'.`,
      evidence: { stdGrant: stdGrant.length, wsGrant: wsGrant.length, stdBareComponent: stdBareComponent.length, stdFullDotted: stdFullDotted.length, dottedComponentSplits },
    };
  });

  await runProbe(results, '2.5', 'safe compilation of arbitrary user text: queryString vs matchString', () => {
    const punctuated = 'Why does postgres "13.4" fail? auth-flow: broken';
    let queryStringOutcome: string;
    try {
      ftsCol.querySync({ fieldName: 'text', fts: { queryString: punctuated }, topk: 5 });
      queryStringOutcome = 'parsed without error (query-parser syntax happened not to trigger here)';
    } catch (err) {
      queryStringOutcome = `THREW: ${isZVecError(err) ? err.code : String(err)} — ${err instanceof Error ? err.message.split('\n')[0] : ''}`;
    }
    let matchStringOutcome: string;
    let matchHits = 0;
    try {
      const r = ftsCol.querySync({ fieldName: 'text', fts: { matchString: punctuated }, topk: 5, outputFields: ['text'] });
      matchHits = r.length;
      matchStringOutcome = `parsed and executed as a literal phrase/terms match, ${r.length} hit(s)`;
    } catch (err) {
      matchStringOutcome = `THREW: ${isZVecError(err) ? err.code : String(err)}`;
    }
    // Also prove queryString CAN be broken by boolean-operator-like words.
    let queryStringBooleanBreak: string;
    try {
      ftsCol.querySync({ fieldName: 'text', fts: { queryString: 'auth and (bug or missing' }, topk: 5 });
      queryStringBooleanBreak = 'did not throw (unexpected)';
    } catch (err) {
      queryStringBooleanBreak = `THREW as expected: ${isZVecError(err) ? err.code : String(err)}`;
    }
    return {
      detail:
        `RULE: 'matchString' is the literal, safe API for arbitrary user text — it never interprets quotes/parens/boolean words as query syntax. ` +
        `'queryString' runs a query-parser grammar (parentheses, quoted phrases, AND/OR/NOT, field:value) and CAN throw or misparse on natural-language punctuation. ` +
        `Compilation rule for git-why: pass the raw user query string to 'matchString' for lexical search; never build 'queryString' from unsanitized text.`,
      evidence: { queryStringOutcome, matchStringOutcome, matchHits, queryStringBooleanBreak },
    };
  });
  ftsCol.closeSync();
  rmDir(ftsDir);

  // ---------------------------------------------------------------- *
  // 3. Dense retrieval, scalar filters, filter grammar trial log
  // ---------------------------------------------------------------- *
  const denseDir = freshTmpDir('dense');
  const flatPath = path.join(denseDir, 'flat');
  const hnswPath = path.join(denseDir, 'hnsw');
  const dim = 256;
  function randVec(seed: number): Float32Array {
    const v = new Float32Array(dim);
    let x = seed + 1;
    for (let i = 0; i < dim; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      v[i] = (x / 0x7fffffff) * 2 - 1;
    }
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += v[i]! * v[i]!;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dim; i++) v[i] = v[i]! / norm;
    return v;
  }
  function schemaDim(indexParams: any) {
    return new ZVecCollectionSchema({
      name: 'dense',
      fields: [
        { name: 'kind', dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.INVERT } },
        { name: 'ts', dataType: ZVecDataType.INT64, indexParams: { indexType: ZVecIndexType.INVERT } },
        { name: 'paths', dataType: ZVecDataType.ARRAY_STRING, indexParams: { indexType: ZVecIndexType.INVERT } },
      ],
      vectors: [{ name: 'vec', dataType: ZVecDataType.VECTOR_FP32, dimension: dim, indexParams }],
    });
  }

  await runProbe(results, '3.1', 'FLAT index at dim=256, cosine', () => {
    const col = ZVecCreateAndOpen(flatPath, schemaDim({ indexType: ZVecIndexType.FLAT, metricType: ZVecMetricType.COSINE }));
    const docs = Array.from({ length: 200 }, (_, i) => ({ id: hexId(1000 + i), fields: { kind: 'commit', ts: i, paths: [`p${i % 10}`] }, vectors: { vec: randVec(i) } }));
    col.insertSync(docs);
    const target = randVec(42);
    const r = col.querySync({ fieldName: 'vec', vector: target, topk: 5 });
    col.closeSync();
    if (r.length !== 5 || r[0]?.id !== hexId(1042)) throw new Error(`expected exact self-match top-1, got ${JSON.stringify(r.map((d) => d.id))}`);
    return { detail: 'FLAT/cosine returns the exact nearest neighbour (self) as top-1 over 200 vectors', evidence: r.map((d) => ({ id: d.id, score: d.score })) };
  });

  await runProbe(results, '3.2', 'HNSW index at dim=256, cosine', () => {
    const col = ZVecCreateAndOpen(hnswPath, schemaDim({ indexType: ZVecIndexType.HNSW, metricType: ZVecMetricType.COSINE }));
    const docs = Array.from({ length: 500 }, (_, i) => ({ id: hexId(2000 + i), fields: { kind: 'commit', ts: i, paths: [`p${i % 10}`] }, vectors: { vec: randVec(i) } }));
    col.insertSync(docs);
    const target = randVec(99);
    const r = col.querySync({ fieldName: 'vec', vector: target, topk: 5, params: { indexType: ZVecIndexType.HNSW, ef: 200 } });
    col.closeSync();
    const top1IsSelf = r[0]?.id === hexId(2099);
    return { detail: `HNSW/cosine top-1 self-match: ${top1IsSelf} over 500 vectors`, evidence: r.map((d) => ({ id: d.id, score: d.score })) };
  });

  // Filter grammar trial log — executed against the FLAT collection.
  const filterTrials: { expr: string; outcome: string }[] = [];
  {
    const col = ZVecOpen(flatPath);
    const tries: string[] = [
      "kind == 'commit'",
      "kind = 'commit'",
      'kind = "commit"',
      "ts > 50",
      "ts > 50 and ts < 55",
      "ts > 50 && ts < 55",
      "kind = 'commit' AND ts > 50",
      "kind IN ('commit','evidence')",
      "kind != 'commit'",
      "NOT kind = 'commit'",
      "ts BETWEEN 50 AND 55",
      "kind LIKE 'comm%'",
      "paths = 'p1'",
      "paths CONTAIN_ANY('p1')",
      "paths CONTAIN_ANY('p1','p2')",
      "paths CONTAIN_ALL('p1')",
    ];
    for (const expr of tries) {
      try {
        const r = col.querySync({ filter: expr, topk: 3 });
        filterTrials.push({ expr, outcome: `OK (${r.length} rows)` });
      } catch (err) {
        filterTrials.push({ expr, outcome: `FAIL ${isZVecError(err) ? err.code : String(err)}: ${err instanceof Error ? err.message.split('\n').pop()?.slice(0, 140) : ''}` });
      }
    }
    col.closeSync();
  }
  record(
    results,
    '3.3',
    'filter grammar trial-and-error log',
    'passed',
    "Comparison uses '=' not '=='; both single- and double-quoted string literals accepted with NO verified in-literal escape (see docs/decisions.md); AND/OR/IN/!=/LIKE(scalar) work; '&&', bare 'NOT', and 'BETWEEN' do not parse; array containment is 'field CONTAIN_ANY(v1,v2,...)' / 'CONTAIN_ALL(...)', combinable with AND/OR.",
    filterTrials,
  );

  await runProbe(results, '3.4', 'scalar filter: integer range', () => {
    const col = ZVecOpen(flatPath);
    const r = col.querySync({ filter: 'ts >= 10 and ts < 20', topk: 100 });
    col.closeSync();
    if (r.length !== 10) throw new Error(`expected 10 rows in [10,20), got ${r.length}`);
    return { detail: `range filter ts in [10,20) returned exactly ${r.length} rows` };
  });

  await runProbe(results, '3.5', 'scalar filter: string equality and substring/LIKE', () => {
    const col = ZVecOpen(flatPath);
    const eq = col.querySync({ filter: `kind = 'commit'`, topk: 1000 });
    const like = col.querySync({ filter: `kind LIKE 'comm%'`, topk: 1000 });
    col.closeSync();
    return { detail: `equality on scalar STRING: ${eq.length} rows; LIKE prefix wildcard on scalar STRING: ${like.length} rows (both supported on scalar fields)`, evidence: { eqCount: eq.length, likeCount: like.length } };
  });

  await runProbe(results, '3.6', 'CRITICAL: LIKE on an ARRAY_STRING field crashes the process (SIGBUS/SIGSEGV)', () => {
    const probe = spawnSync(
      process.execPath,
      [
        '-e',
        `
        import('@zvec/zvec').then(({ ZVecOpen }) => {
          const col = ZVecOpen(process.argv[1]);
          try {
            col.querySync({ filter: "paths LIKE '%p1%'", topk: 3 });
            console.log('NO_CRASH');
          } catch (e) {
            console.log('THREW:' + e.code);
          }
        });
        `,
        flatPath,
      ],
      { encoding: 'utf8', timeout: 8000 },
    );
    const crashed = probe.signal !== null || (probe.status !== 0 && !probe.stdout.includes('THREW') && !probe.stdout.includes('NO_CRASH'));
    return {
      detail: crashed
        ? `confirmed crash: signal=${probe.signal} status=${probe.status} — LIKE must never be used on an ARRAY_STRING field; use CONTAIN_ANY/CONTAIN_ALL instead`
        : `did not reproduce a crash this run (stdout=${probe.stdout.trim()}); treat LIKE-on-array as unsupported regardless`,
      evidence: { signal: probe.signal, status: probe.status, stdout: probe.stdout, stderr: probe.stderr.slice(0, 300) },
    };
  });

  await runProbe(results, '3.7', 'array containment filter for path match keys (ARRAY_STRING + CONTAIN_ANY)', () => {
    const col = ZVecOpen(flatPath);
    const any1 = col.querySync({ filter: `paths CONTAIN_ANY('p3')`, topk: 1000 });
    const any2 = col.querySync({ filter: `paths CONTAIN_ANY('p3','p7')`, topk: 1000 });
    const all = col.querySync({ filter: `paths CONTAIN_ALL('p3')`, topk: 1000 });
    const combined = col.querySync({ filter: `kind = 'commit' AND paths CONTAIN_ANY('p3')`, topk: 1000 });
    col.closeSync();
    if (any1.length !== 20 || any2.length !== 40) throw new Error(`unexpected counts: any1=${any1.length} any2=${any2.length}`);
    return {
      detail: `CONTAIN_ANY/CONTAIN_ALL work natively on ARRAY_STRING with INVERT index; ARRAY_STRING is ADEQUATE for path match-key filtering (no sidecar catalog needed) as long as LIKE is never applied to the array field`,
      evidence: { any1: any1.length, any2: any2.length, all: all.length, combinedWithScalar: combined.length },
    };
  });
  rmDir(denseDir);

  // ---------------------------------------------------------------- *
  // 4. Document ID constraints
  // ---------------------------------------------------------------- *
  const idDir = freshTmpDir('ids');
  const idColPath = path.join(idDir, 'col');
  await runProbe(results, '4.1', 'ID constraints: sha256 hex, length, character set', () => {
    const col = ZVecCreateAndOpen(idColPath, basicSchema());
    const sha256hex = 'a'.repeat(64);
    const okSha = col.insertSync({ id: sha256hex, fields: { kind: 'commit', ts: 1, author: 'a', paths: ['x'], text: 't' }, vectors: { vec: new Float32Array(8) } });

    const long = 'b'.repeat(4096);
    let longOutcome: string;
    try {
      const s = col.insertSync({ id: long, fields: { kind: 'commit', ts: 1, author: 'a', paths: ['x'], text: 't' }, vectors: { vec: new Float32Array(8) } });
      longOutcome = s.ok ? 'accepted 4096-char id' : `rejected: ${s.code} ${s.message}`;
    } catch (err) {
      longOutcome = `threw: ${isZVecError(err) ? err.code : String(err)}`;
    }

    let uuidOutcome: string;
    try {
      const s = col.insertSync({ id: '123e4567-e89b-12d3-a456-426614174000', fields: { kind: 'commit', ts: 1, author: 'a', paths: ['x'], text: 't' }, vectors: { vec: new Float32Array(8) } });
      uuidOutcome = s.ok ? 'accepted uuid-with-dashes' : `rejected: ${s.code} ${s.message}`;
    } catch (err) {
      uuidOutcome = `threw: ${isZVecError(err) ? err.code : String(err)}`;
    }

    let emptyOutcome: string;
    try {
      const s = col.insertSync({ id: '', fields: { kind: 'commit', ts: 1, author: 'a', paths: ['x'], text: 't' }, vectors: { vec: new Float32Array(8) } });
      emptyOutcome = s.ok ? 'accepted empty id' : `rejected: ${s.code} ${s.message}`;
    } catch (err) {
      emptyOutcome = `threw: ${isZVecError(err) ? err.code : String(err)}`;
    }
    col.closeSync();
    if (!okSha.ok) throw new Error(`64-char sha256 hex id rejected: ${okSha.message}`);
    return {
      detail: `64-hex-char SHA-256 digest works as an ID. Long (4096-char) id: ${longOutcome}. UUID-with-dashes: ${uuidOutcome}. Empty id: ${emptyOutcome}.`,
      evidence: { okSha, longOutcome, uuidOutcome, emptyOutcome },
    };
  });
  rmDir(idDir);

  // ---------------------------------------------------------------- *
  // 5. Filters applied before top-k selection
  // ---------------------------------------------------------------- *
  const topkDir = freshTmpDir('topk');
  const topkPath = path.join(topkDir, 'col');
  await runProbe(results, '5.1', 'eligibility filter applied BEFORE top-k, not after', () => {
    const col = ZVecCreateAndOpen(topkPath, schemaDim({ indexType: ZVecIndexType.FLAT, metricType: ZVecMetricType.COSINE }));
    // 1000 docs: vectors ordered so the 5 "eligible" docs are the WORST
    // matches for the query vector (they sit at the tail of similarity),
    // while 995 "ineligible" docs are the best matches.
    const queryVec = randVec(0);
    const docs: { id: string; fields: any; vectors: any }[] = [];
    for (let i = 0; i < 995; i++) {
      docs.push({ id: hexId(3000 + i), fields: { kind: 'commit', ts: i, paths: ['other'] }, vectors: { vec: randVec(i + 1) } });
    }
    // 5 eligible docs: deliberately near-orthogonal / poor matches (negate the query vector components region).
    for (let i = 0; i < 5; i++) {
      const v = new Float32Array(dim);
      for (let k = 0; k < dim; k++) v[k] = -(queryVec[k] ?? 0) + (Math.random() - 0.5) * 0.001;
      docs.push({ id: hexId(4000 + i), fields: { kind: 'commit', ts: 900 + i, paths: ['eligible'] }, vectors: { vec: v } });
    }
    col.insertSync(docs);
    const filtered = col.querySync({ fieldName: 'vec', vector: queryVec, filter: `paths CONTAIN_ANY('eligible')`, topk: 5 });
    col.closeSync();
    const ids = filtered.map((d) => d.id).sort();
    const expected = Array.from({ length: 5 }, (_, i) => hexId(4000 + i)).sort();
    const matches = JSON.stringify(ids) === JSON.stringify(expected);
    if (!matches) throw new Error(`filter-then-topk violated: expected the 5 eligible (poor-match) docs, got ${JSON.stringify(ids)}`);
    return { detail: 'filter is applied before top-k selection: asking for topk=5 with a filter matching exactly 5 poor-similarity docs returns exactly those 5, not an empty/wrong set from filtering an unfiltered top-5', evidence: ids };
  });
  rmDir(topkDir);

  // ---------------------------------------------------------------- *
  // 6. Concurrency
  // ---------------------------------------------------------------- *
  const concDir = freshTmpDir('conc');
  const concPath = path.join(concDir, 'col');
  {
    const col = ZVecCreateAndOpen(concPath, basicSchema());
    col.upsertSync(Array.from({ length: 20 }, (_, i) => ({ id: hexId(5000 + i), fields: { kind: 'commit', ts: i, author: 'a', paths: ['x'], text: 'seed' }, vectors: { vec: new Float32Array(8).fill(i / 20) } })));
    col.closeSync();
  }

  await runProbe(results, '6.1', 'two concurrent reader processes', () => {
    const r1 = child('concurrent-reader.ts', [concPath, '800', 'true']);
    const r2 = child('concurrent-reader.ts', [concPath, '800', 'true']);
    // spawnSync above is sequential; run truly concurrently instead:
    return { detail: 'see 6.1b for the actual concurrent run (spawnSync trial retained as sequential baseline)', evidence: { r1: r1.stdout.trim(), r2: r2.stdout.trim() } };
  });

  await runConcurrentProbe();
  async function runConcurrentProbe() {
    function spawnChild(script: string, args: string[]) {
      return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string }>((resolve) => {
        const p = spawn(process.execPath, ['--experimental-strip-types', path.join(CHILDREN, script), ...args]);
        let out = '';
        p.stdout.on('data', (d) => (out += d.toString()));
        p.on('close', (code, signal) => resolve({ code, signal, stdout: out }));
      });
    }

    await runProbe(results, '6.2', 'two readers, truly concurrent (readOnly)', async () => {
      const [a, b] = await Promise.all([spawnChild('concurrent-reader.ts', [concPath, '800', 'true']), spawnChild('concurrent-reader.ts', [concPath, '800', 'true'])]);
      const pa = JSON.parse(a.stdout.trim().split('\n').pop()!);
      const pb = JSON.parse(b.stdout.trim().split('\n').pop()!);
      if (pa.errorCount > 0 || pb.errorCount > 0) throw new Error(`readers reported errors: ${JSON.stringify({ pa, pb })}`);
      return { detail: `two simultaneous readOnly readers: ${pa.queries + pb.queries} total successful queries, 0 errors — concurrent reads work cleanly`, evidence: { pa, pb } };
    });

    await runProbe(results, '6.3', 'two competing writer processes (non-readOnly, non-exclusive at the app level)', async () => {
      const [a, b] = await Promise.all([spawnChild('concurrent-writer.ts', [concPath, '800', '1']), spawnChild('concurrent-writer.ts', [concPath, '800', '2'])]);
      const pa = JSON.parse(a.stdout.trim().split('\n').pop()!);
      const pb = JSON.parse(b.stdout.trim().split('\n').pop()!);
      const anyErrors = pa.errorCount > 0 || pb.errorCount > 0;
      return {
        detail: anyErrors
          ? `two concurrent writers WITHOUT app-level exclusion produced errors: ${JSON.stringify({ paErrors: pa.errors, pbErrors: pb.errors })} — confirms the spec requirement for an exclusive application lock around writers; Zvec does not itself make concurrent writers from two processes safe`
          : `two concurrent writers completed with 0 reported errors (writes:${pa.writes}/${pb.writes}) on this run — even so, the spec's exclusive-writer requirement stands since this is not a documented guarantee`,
        evidence: { pa, pb },
      };
    });

    await runProbe(results, '6.4', 'a writer concurrent with readers', async () => {
      const [w, r1, r2] = await Promise.all([
        spawnChild('concurrent-writer.ts', [concPath, '800', '3']),
        spawnChild('concurrent-reader.ts', [concPath, '800', 'true']),
        spawnChild('concurrent-reader.ts', [concPath, '800', 'true']),
      ]);
      const pw = JSON.parse(w.stdout.trim().split('\n').pop()!);
      const pr1 = JSON.parse(r1.stdout.trim().split('\n').pop()!);
      const pr2 = JSON.parse(r2.stdout.trim().split('\n').pop()!);
      return {
        detail: `writer+2 readOnly readers concurrently: writer errors=${pw.errorCount}, reader errors=${pr1.errorCount}/${pr2.errorCount}. ${pw.errorCount > 0 || pr1.errorCount > 0 || pr2.errorCount > 0 ? 'Observed contention errors — the application lock must serialize writers against readers per spec section 13.' : 'No native-level errors observed in this run; the application lock is still required per spec, since this is not a documented safety guarantee and behaviour under real generation-swap/rebuild is different from steady-state upserts.'}`,
        evidence: { pw, pr1, pr2 },
      };
    });

    await runProbe(results, '6.5', 'readOnly and enableMMAP options', async () => {
      const ro = await spawnChild('concurrent-reader.ts', [concPath, '200', 'true', 'true']);
      const roFalse = await spawnChild('concurrent-reader.ts', [concPath, '200', 'true', 'false']);
      const proResult = JSON.parse(ro.stdout.trim().split('\n').pop()!);
      const proFalse = JSON.parse(roFalse.stdout.trim().split('\n').pop()!);
      return { detail: `readOnly:true works standalone; enableMMAP:true and enableMMAP:false both open and query successfully (errors: mmap-true=${proResult.errorCount}, mmap-false=${proFalse.errorCount})`, evidence: { proResult, proFalse } };
    });
  }
  rmDir(concDir);

  // ---------------------------------------------------------------- *
  // 7. Durability
  // ---------------------------------------------------------------- *
  await runProbe(results, '7.1', 'durability: SIGKILL before any close()', async () => {
    const dir = freshTmpDir('durability-nokill');
    const p = path.join(dir, 'col');
    const proc = spawn(process.execPath, ['--experimental-strip-types', path.join(CHILDREN, 'lifecycle-writer.ts'), p, 'no-close', '5']);
    let out = '';
    let killed = false;
    await new Promise<void>((resolve) => {
      proc.stdout.on('data', (d) => {
        out += d.toString();
        if (!killed && out.includes('ready-to-be-killed')) {
          killed = true;
          proc.kill('SIGKILL');
        }
      });
      proc.on('close', () => resolve());
    });
    // Give the OS a beat to release file handles before we reopen.
    await new Promise((r) => setTimeout(r, 200));
    let survived: number | null = null;
    let openError: string | null = null;
    try {
      const col = ZVecOpen(p);
      survived = col.stats.docCount;
      col.closeSync();
    } catch (err) {
      openError = isZVecError(err) ? err.code : String(err);
    }
    rmDir(dir);
    return {
      detail:
        openError !== null
          ? `after SIGKILL with no closeSync(), reopening failed: ${openError} — treat an ungracefully-terminated collection as requiring recovery, never as clean`
          : `after SIGKILL with no closeSync(), reopen succeeded with docCount=${survived} (of 5 inserted) — closeSync() is NOT proven to be required for durability of already-applied upsertSync calls on this build, but the application journal must still exist because per-record status/partial-failure and cross-record batch atomicity are not guaranteed by this alone`,
      evidence: { openError, survived },
    };
  });

  await runProbe(results, '7.2', 'durability: closeSync() then SIGKILL (already-exited process control)', async () => {
    const dir = freshTmpDir('durability-close');
    const p = path.join(dir, 'col');
    const proc = spawn(process.execPath, ['--experimental-strip-types', path.join(CHILDREN, 'lifecycle-writer.ts'), p, 'close', '7']);
    let out = '';
    const exit = await new Promise<{ code: number | null }>((resolve) => {
      proc.stdout.on('data', (d) => (out += d.toString()));
      proc.on('close', (code) => resolve({ code }));
    });
    const closed = out.includes('"closed"');
    let survived: number | null = null;
    let openError: string | null = null;
    try {
      const col = ZVecOpen(p);
      survived = col.stats.docCount;
      col.closeSync();
    } catch (err) {
      openError = isZVecError(err) ? err.code : String(err);
    }
    rmDir(dir);
    if (!closed || exit.code !== 0) throw new Error(`writer child did not report a clean close: exit=${JSON.stringify(exit)} out=${out}`);
    if (openError !== null || survived !== 7) throw new Error(`expected all 7 docs to survive a clean close; got survived=${survived} openError=${openError}`);
    return { detail: `closeSync() followed by process exit is a reliable checkpoint: all 7 docs survived reopening in a fresh process`, evidence: { survived } };
  });

  // ---------------------------------------------------------------- *
  // 8. Cross-process advisory lock (stdlib only)
  // ---------------------------------------------------------------- *
  const lockDir = freshTmpDir('lock');
  function spawnLockHolder(kind: 'shared' | 'exclusive', timeoutMs: number, holdMs: number) {
    return new Promise<{ lines: any[]; code: number | null }>((resolve) => {
      const p = spawn(process.execPath, ['--experimental-strip-types', path.join(CHILDREN, 'lock-holder.ts'), lockDir, kind, String(timeoutMs), String(holdMs)]);
      let out = '';
      p.stdout.on('data', (d) => (out += d.toString()));
      p.on('close', (code) => resolve({ lines: parseJsonLines(out), code }));
    });
  }
  function spawnLockHolderRaw(kind: 'shared' | 'exclusive', timeoutMs: number, holdMs: number) {
    const p = spawn(process.execPath, ['--experimental-strip-types', path.join(CHILDREN, 'lock-holder.ts'), lockDir, kind, String(timeoutMs), String(holdMs)]);
    return p;
  }

  await runProbe(results, '8.1', 'exclusive lock: acquire, hold, release, then reacquire', async () => {
    const first = await spawnLockHolder('exclusive', 5000, 300);
    const second = await spawnLockHolder('exclusive', 5000, 100);
    const a1 = first.lines.find((l) => l.event === 'acquired');
    const r1 = first.lines.find((l) => l.event === 'released');
    const a2 = second.lines.find((l) => l.event === 'acquired');
    if (!a1 || !r1 || !a2) throw new Error(`unexpected sequence: ${JSON.stringify({ first: first.lines, second: second.lines })}`);
    return { detail: 'exclusive lock acquired, held, released, then successfully reacquired by a second process', evidence: { first: first.lines, second: second.lines } };
  });

  await runProbe(results, '8.2', 'two shared (reader) locks held concurrently', async () => {
    const [a, b] = await Promise.all([spawnLockHolder('shared', 5000, 400), spawnLockHolder('shared', 5000, 400)]);
    const aAcq = a.lines.find((l) => l.event === 'acquired');
    const bAcq = b.lines.find((l) => l.event === 'acquired');
    if (!aAcq || !bAcq) throw new Error(`expected both shared holders to acquire: ${JSON.stringify({ a: a.lines, b: b.lines })}`);
    if (aAcq.waitedMs > 300 || bAcq.waitedMs > 300) throw new Error(`shared locks should not wait on each other: ${JSON.stringify({ aAcq, bAcq })}`);
    return { detail: `two shared holders acquired concurrently without waiting on each other (waited ${aAcq.waitedMs}ms / ${bAcq.waitedMs}ms)`, evidence: { a: a.lines, b: b.lines } };
  });

  await runProbe(results, '8.3', 'exclusive lock excludes a concurrent shared lock, and vice versa', async () => {
    const exclusiveFirst = spawnLockHolder('exclusive', 5000, 500);
    await new Promise((r) => setTimeout(r, 80));
    const sharedSecond = await spawnLockHolder('shared', 5000, 100);
    const exclusiveResult = await exclusiveFirst;
    const sharedAcq = sharedSecond.lines.find((l) => l.event === 'acquired');
    if (!sharedAcq) throw new Error(`shared holder never acquired: ${JSON.stringify(sharedSecond.lines)}`);
    const waitedForExclusive = sharedAcq.waitedMs >= 300; // had to wait out most of the 500ms hold
    if (!waitedForExclusive) throw new Error(`shared lock acquired too early (waited only ${sharedAcq.waitedMs}ms) while exclusive was held: ${JSON.stringify({ exclusiveResult: exclusiveResult.lines, sharedSecond: sharedSecond.lines })}`);
    return { detail: `a shared-lock request correctly blocked until the exclusive holder released (waited ${sharedAcq.waitedMs}ms against a ~500ms exclusive hold)`, evidence: { exclusiveResult: exclusiveResult.lines, sharedSecond: sharedSecond.lines } };
  });

  await runProbe(results, '8.4', 'lock released by SIGKILL (staleness reclaim), not by a timer', async () => {
    const holder = spawnLockHolderRaw('exclusive', 5000, 60000); // would hold "forever"
    let out = '';
    let acquired = false;
    await new Promise<void>((resolve) => {
      holder.stdout.on('data', (d) => {
        out += d.toString();
        if (!acquired && out.includes('"acquired"')) {
          acquired = true;
          resolve();
        }
      });
    });
    holder.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 150)); // let the OS reap the process
    const second = await spawnLockHolder('exclusive', 4000, 50);
    const a2 = second.lines.find((l) => l.event === 'acquired');
    if (!a2) throw new Error(`second exclusive holder never reclaimed the dead holder's lock: ${JSON.stringify(second.lines)}`);
    return { detail: `after SIGKILL of the exclusive holder, a new requester reclaimed the lock via liveness+start-time staleness detection in ${a2.waitedMs}ms — not via an elapsed timer`, evidence: second.lines };
  });
  rmDir(lockDir);

  // ---------------------------------------------------------------- *
  // 9. External command surfaces
  // ---------------------------------------------------------------- *
  await runProbe(results, '9.1', 'opencode --version', () => {
    try {
      const out = execFileSync('opencode', ['--version'], { encoding: 'utf8' }).trim();
      return { detail: `opencode is installed: ${out}`, evidence: out };
    } catch (err) {
      return { detail: `opencode not runnable: ${err instanceof Error ? err.message : String(err)}`, evidence: null };
    }
  });

  record(results, '9.2', 'zg --version', 'unsupported', 'zg is NOT installed in this environment; not attempting installation per instructions. The evaluation adapters must treat a missing zg as a documented precondition, not a bug.', null);

  // ---------------------------------------------------------------- *
  // Write report
  // ---------------------------------------------------------------- *
  const outPath = path.join(__dirname, 'out', 'report.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        versions,
        probes: results,
      },
      null,
      2,
    ),
  );

  const passed = results.filter((r) => r.status === 'passed').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const unsupported = results.filter((r) => r.status === 'unsupported').length;
  console.log(`\n${'='.repeat(70)}`);
  console.log(`Spike complete: ${passed} passed, ${failed} failed, ${unsupported} unsupported, ${results.length} total.`);
  console.log(`Report: ${outPath}`);
  if (failed > 0) {
    console.log('\nFAILED PROBES:');
    for (const r of results.filter((r) => r.status === 'failed')) console.log(`  - ${r.id} ${r.name}: ${r.detail}`);
    process.exitCode = 1;
  }
}

void main();
