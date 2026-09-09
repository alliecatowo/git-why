# Empirical decisions from the capability spike

This records what `spike/run.ts` actually executed and observed against the
installed `@zvec/zvec@0.7.1` (native binding `@zvec/bindings-darwin-arm64@0.7.1`)
on darwin-arm64, Node v24.21.0, git 2.50.1. Full machine-readable detail is in
`spike/out/report.json`; this file is the human-readable digest that the
storage, retrieval, and CLI lanes should treat as authoritative for anything
"documented" vs "executed and passed" below. Every claim here is EXECUTED
AND PASSED unless marked otherwise.

Re-running: `node --experimental-strip-types spike/run.ts`.

## 1. Lifecycle, persistence

- `ZVecCreateAndOpen`/`ZVecOpen`/`insertSync`/`upsertSync`/`deleteSync`/
  `deleteByFilterSync`/`closeSync` all behave as documented.
- `fetchSync({ ids, includeVector: false })` returns `vectors: {}` (an empty
  object), never `undefined` and never the vector data. Callers must check
  `Object.keys(doc.vectors).length === 0`, not identity against `undefined`.
- Data survives a full process boundary: write + `closeSync()` in one
  process, then `ZVecOpen` + `fetchSync` in a second process sees everything.
  **`closeSync()` followed by process exit is a verified durability
  checkpoint** (probe 7.2).

## 2. Full-text search

- **`matchString` is the safe API for arbitrary user text.** It never
  interprets quotes, parentheses, or boolean-looking words as query syntax.
  **`queryString` runs an actual query-parser grammar** (parens, quoted
  phrases, `AND`/`OR`/`NOT`, presumably field-prefixed terms) and can throw
  `ZVEC_INVALID_ARGUMENT` on ordinary natural-language punctuation (e.g.
  `auth and (bug or missing` — an unbalanced paren from a truncated user
  query — throws). **Rule: compile every user-supplied lexical query through
  `fts.matchString`, never `fts.queryString`, unless git-why itself is the
  one constructing a trusted query-parser expression.**
- The `standard` tokenizer follows Unicode word boundaries and **does not
  split camelCase or snake_case, and keeps dotted sequences (`13.4`,
  `user.isAdmin`) as a single token.** Searching for a bare inner component
  (`Session` out of `AuthSessionProvider`, `isAdmin` out of `user.isAdmin`)
  matches nothing; only the full original token matches.
  - **Consequence for the retrieval lane's lexical normalization (spec
    section 9):** it must explicitly emit split components (camelCase
    parts, snake_case parts, dotted/path/version segments) as _additional_
    lexical tokens alongside the original text. The native tokenizer will
    never do this splitting on its own, for identifiers or diff content.
- Numbers and dotted version strings are preserved distinctly and are not
  confused with each other (`13.4` and `13.9` are different tokens).
- Diff markers (`-`/`+` prefixes on removed/added lines) do **not** corrupt
  or merge with the adjacent token under the `standard` tokenizer — a line
  prefixed with `-`, `+`, or nothing tokenizes identically. No stripping of
  diff markers is required before indexing.
- The `whitespace` tokenizer is **unsuitable for code**: punctuation directly
  attached to an identifier (`grantAccess();`) never separates from it, so a
  bare-identifier search matches nothing. Use `standard`, not `whitespace`,
  for both `lexicalText` and `sourceExcerpt`-adjacent fields.
- `lowercase` and `stemmer` filters did not change any of the above
  identifier-tokenization results in these tests; `lowercase` is still
  wanted for case-insensitive prose matching.

## 3. Filter expression grammar (undocumented in the package; reverse-engineered)

The filter grammar is SQL-like, ANTLR-based (error messages come from
`sqlengine_impl.cc` and quote ANTLR token names). Verified productions:

- Comparison operators: `=`, `!=`, `<`, `>`, `<=`, `>=`. **`==` is a syntax
  error** — always `=` for equality.
- Boolean connectives: `AND`, `OR` (case-insensitive: `and`/`or` both work).
  **`&&` and `||` are lexer errors.** A bare `NOT <expr>` prefix is a syntax
  error in this build; use `field != value` instead of `NOT field = value`.
- `BETWEEN x AND y` did **not** parse in these tests (syntax error after the
  first bound) — use `field >= x AND field < y` instead.
- `IN ('a', 'b', ...)` works on scalar fields.
- String literals accept **both** `'...'` and `"..."` as delimiters.
  **No working in-literal escape mechanism was found** — neither SQL-style
  doubling (`'don''t'`) nor backslash-escaping (`'don\'t'`) parses as a
  single literal containing the quote character; both throw or silently
  fail to mean what you'd expect. **Verified-safe strategy: pick whichever
  delimiter character does not occur in the value.** If a value contains
  _both_ `'` and `"`, there is no proven-safe way to embed it literally in a
  filter expression with this build. `src/index/collection.ts` avoids this
  entirely by stripping quote characters from values it _generates_ for
  indexed scalar fields (the normalized author search value; path match
  keys are derived, quote-free path segments) rather than trying to escape
  arbitrary content.
- `LIKE 'prefix%'` works on **scalar `STRING`** fields.
  **`LIKE` on an `ARRAY_STRING` field crashes the process (SIGSEGV) — this
  is a hard, confirmed native crash, not a rejected argument.** Never call
  `LIKE` against an array-typed field, under any circumstance.
- Array containment for `ARRAY_STRING` fields (the mechanism used for path
  match-key filtering) is: `field CONTAIN_ANY(v1, v2, ...)` and
  `field CONTAIN_ALL(v1, v2, ...)`. Both compose with `AND`/`OR` against
  other scalar predicates (`kind = 'commit' AND paths CONTAIN_ANY('src')`
  works). This was tested at up to a few hundred rows with an `INVERT`
  index on the array field and returned exactly the expected result sets.
  **Decision: `ARRAY_STRING` + `INVERT` + `CONTAIN_ANY`/`CONTAIN_ALL` is
  adequate for path match-key filtering. The sidecar path catalog described
  as a fallback in spec section 8 is NOT needed** — provided `LIKE` is never
  applied to that field.
- Filters compose with vector queries (`fieldName` + `vector` + `filter`)
  and are applied **before** top-k selection: a 1000-document FLAT/cosine
  collection where the filter matches exactly 5 documents that are the
  _worst_ similarity matches for the query vector, queried with
  `topk: 5` and that filter, returns exactly those 5 documents — never an
  empty or wrong result from filtering an already-selected top-5 (probe
  5.1). This is the eligibility-before-top-k guarantee spec sections 8 and
  14 require, and it holds natively; no adapter-side pre-filtering pass is
  needed for a single Zvec `querySync` call.

### 3a. API gotcha: `undefined` is not a valid "omitted" options argument

`ZVecOpen(path, options)` and `ZVecCreateAndOpen(path, schema, options)`
both throw `ZVEC_INVALID_ARGUMENT` ("argument 'options' must be a
CollectionOptions object") if called with an explicit `options: undefined`
— the idiomatic JS pattern of `fn(path, maybeOptions)` where
`maybeOptions` is `ZVecCollectionOptions | undefined` does NOT work here;
the third argument must be omitted entirely when there are no options.
`src/index/collection.ts`'s `openOrCreateHistoryCollection` branches on
`options !== undefined` and calls the binding with a different arity
rather than forwarding `undefined`. Discovered while wiring
`src/index/refresh.ts` against a real collection, not in the original
spike run — worth knowing before anyone else calls these two entry points.

## 4. Dense retrieval

- `FLAT` and `HNSW` indexes at dimension 256 with `metricType: COSINE` both
  return the exact self-match as the top-1 result for a held-out query
  vector, over 200 (FLAT) and 500 (HNSW, `ef: 200`) inserted vectors.
- Both index types accept `filter` alongside `vector` search in the same
  `querySync` call.

## 5. Document ID constraints

- A 64-character lowercase-hex SHA-256 digest works as an ID (this is
  exactly `DOC_ID_VERSION`'s target shape from `src/types.ts`).
- A UUID-with-dashes (36 chars, `-` included) is accepted.
- A 4096-character ID is **rejected** with `ZVEC_INVALID_ARGUMENT` (insert
  status `ok: false`). There is a length ceiling somewhere below 4096; 64
  hex chars is comfortably under it.
- An empty-string ID is rejected with `ZVEC_INVALID_ARGUMENT`.
- Conclusion: the spec's deterministic SHA-256-digest-of-a-versioned-tuple
  ID scheme (section 8) is compatible with the binding's ID constraints
  as-is; no truncation or re-encoding is needed.

## 6. Concurrency (real child processes)

- **Two simultaneous `readOnly: true` readers**: clean. 13,408 total
  successful queries across both processes in an 800ms window, zero errors.
  No platform limitation to report for darwin-arm64; concurrent reads of a
  stable, unchanging collection work without any application-level
  coordination.
- **Two simultaneous writers opening and upserting into the same collection
  path, with no application-level exclusion**: one of the two writer
  processes failed to even _open_ the collection (`ZVEC_INTERNAL_ERROR`).
  **Confirms the spec's requirement for an application-level exclusive
  writer lock — Zvec does not make concurrent multi-process writers safe on
  its own**, and the failure mode is not a clean, retryable rejection.
- **One writer concurrent with two `readOnly` readers, no application-level
  coordination**: readers logged a small number of transient errors while
  the writer was active. This is consistent with the spec's requirement
  that writers hold exclusive access through mutation and readers hold
  shared access only against a stable, non-mutating collection — V1 does
  not attempt to serve a snapshot of an actively-mutated collection.
- `readOnly: true` and `enableMMAP: true`/`false` were both exercised
  successfully as standalone options; neither caused errors in isolation.

**Design implication:** the `src/index/lock.ts` shared/exclusive advisory
lock (below) is load-bearing, not optional. All the above native-level
findings assume the _only_ two access modes that occur across processes in
production are "many readers of a generation nobody is writing to" and
"exactly one writer, nobody else touching that generation" — which is what
the lock is for.

## 7. Durability

- **`closeSync()` then process exit is a verified checkpoint**: a batch of
  7 upserts, `closeSync()`, then `SIGKILL` of the (already-exited, so this
  is really just confirming no hidden async work) process, followed by
  reopening in a fresh process, shows all 7 documents present.
- **`SIGKILL` with _no_ `closeSync()` call at all**, immediately after a
  batch of 5 `upsertSync` calls returned successfully: reopening in a fresh
  process showed all 5 documents present. This was reproducible in this
  environment, but is **not** being treated as a documented guarantee —
  it's an observed behavior of this build's write path (likely: each
  `upsertSync` call is durable to its on-disk segment/WAL immediately, and
  `closeSync()` mainly flushes index structures and releases the file
  lock). **`src/index/journal.ts` still implements the full
  pending-batch-durable-before-apply protocol from spec section 12**,
  because (a) partial-failure status arrays are per-record and must be
  checked regardless of this finding, (b) this finding says nothing about
  atomicity _across_ a multi-record batch under a crash mid-batch, and (c)
  relying on an unverified/undocumented internal durability behavior would
  violate spec section 12's explicit instruction not to invent guarantees
  beyond what's tested. The journal is what makes the batch atomic and
  recoverable; this finding just means we are not depending on
  `closeSync()` as the _only_ durability mechanism.
- A crash between a `ForwardBlock`/index-segment write and its rename left
  residue files on disk that the _next_ open cleaned up automatically with
  a warning log line ("possible crash residue; cleaning and overwriting").
  This is a helpful native self-repair behavior but is not a substitute for
  the application journal, which must still track which _logical_ batch was
  pending so `commits.jsonl`/manifest state stays consistent with what the
  collection actually contains.

## 8. Cross-process advisory lock (Node stdlib only; no new dependency)

Implemented and tested in `spike/lock-proto.ts` (productionized as
`src/index/lock.ts`). No npm package was added or found necessary — see
"Dependency conclusion" below.

Protocol: an exclusive marker file (`repository.lock`, created via
`fs.openSync(path, 'wx')`, i.e. `O_CREAT | O_EXCL`) plus a `readers/`
directory of one file per shared holder (`<pid>-<random>.json`, also
created via `wx` so creation can never collide). Each token file contains
`{ pid, startTime, acquiredAt }`, where `startTime` is the owning process's
start time as reported by `ps -o lstart= -p <pid>` — a "boot-unique-enough"
token obtained without any extra dependency, used to detect pid reuse after
a crash (if the same pid is alive but its recorded start time no longer
matches, the original process is gone and its lock is stale).

- **Reader (shared) acquire**: if the exclusive marker exists, first check
  whether its owner is stale (dead, or pid reused) and reclaim if so;
  otherwise back off and retry. Once the marker is absent, create a reader
  token file, then _re-check_ the marker — if a writer raced in between,
  remove the just-created reader file and retry. This is a
  register-then-verify pattern, not a naive check-then-act.
- **Writer (exclusive) acquire**: prune stale reader files; if any live
  reader remains or the exclusive marker exists (and is live), back off and
  retry. Otherwise create the exclusive marker, then _re-check_ the readers
  directory — if any reader file is present (even a soon-to-back-off one),
  remove the marker and back off rather than risk overlapping a reader that
  had already passed its own re-check. This trades a small amount of
  liveness for a hard safety guarantee: a writer never proceeds while any
  reader token could possibly still be active.
- **Release** is simply deleting the owning process's token file(s). If the
  process dies without releasing, the _next_ acquirer of the opposite kind
  reclaims the lock via the staleness check above — release is never
  time-based.

Tested with real child processes (probes 8.1–8.4):

- Exclusive acquire → hold → release → a second process re-acquires: works.
- Two shared holders acquire concurrently without waiting on each other
  (both acquired in single-digit milliseconds).
- An exclusive holder correctly blocks a concurrent shared request for the
  full duration of its hold (shared request waited ~700ms against a ~500ms
  exclusive hold — i.e. it never snuck in early).
- **A `SIGKILL`ed exclusive holder's lock is reclaimed by staleness
  detection, not a timer**: a second exclusive requester acquired the lock
  ~7ms after the first was killed (well under any plausible timeout),
  because `ps -o lstart=` for that pid immediately came back empty (process
  gone), not because a wait period elapsed.

**Dependency conclusion: no npm package is required.** `fs.openSync` with
`'wx'` plus `child_process.execFileSync('ps', ...)` for the liveness/reuse
check are both Node stdlib. This satisfies spec section 13's shared/
exclusive, termination-safe, non-timer-based lock requirement without
adding to the runtime dependency budget.

## 9. External command surfaces

- `opencode --version` → `1.18.30`. Runnable via `execFileSync('opencode',
['--version'])`.
- `zg --version` → **not installed** in this environment (`zg: command not
found`). Per instructions, no attempt was made to install it. The
  evaluation adapters (bench lane) must treat a missing `zg` as a
  documented precondition to skip/report, not as a bug to work around.

## What this changes vs. the spec's stated fallback options

- Spec section 8 allows a "small sidecar path catalog" if array filtering
  proves inadequate. **It did not prove inadequate** — `ARRAY_STRING` +
  `INVERT` + `CONTAIN_ANY`/`CONTAIN_ALL` handles path match-key eligibility
  filtering correctly and is what `src/index/collection.ts` uses. No
  sidecar catalog is implemented.
- Spec section 13 leaves the "particular Node lock package" as a spike
  decision. **No package was needed or added**; the stdlib-only protocol
  above is what ships.
