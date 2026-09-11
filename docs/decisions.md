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

## The constrained-budget test, and why it failed

Accuracy saturated at the default 60-tool-call budget: every arm cited the
verified commit on every graded trial. The effort measurement suggested a way
past the ceiling -- the baseline needed a median of 16 tool calls and Git Why
9 -- so the same nine questions were re-run at a budget of 10, chosen to sit
between those figures.

The prediction, recorded before the run: the baseline would exhaust the budget
on several tasks while Git Why still fit, converting a measured effort
difference into an accuracy difference.

It did not. The budget was exceeded 5 times in arm A and 4 times in each of
B, C and D, and every arm still scored 100% on the trials that completed.
Median tool calls on completed trials fell to 7.5-9.5 for ALL arms, including
the baseline: told it has ten calls, a capable model simply becomes more
economical instead of running out. That possibility was stated before the run
and is what happened.

Two things follow, and the second is the more important one.

The effort advantage is real but conditional. Git Why halves the work a model
does when the work is unconstrained; it does not unlock answers the baseline
cannot reach when the budget is tight, because the baseline adapts.

And the ceiling is not an artifact to be engineered around. Two attempts have
now been made to find an operating point where these questions separate the
arms -- harder corpora, then a tighter budget -- and neither did. At some
point the honest reading is that a capable model with ordinary Git commands
answers this class of question, and the value of a retrieval tool here is cost
and latency rather than capability. Further searching for a configuration that
produces a positive result would be fitting the experiment to a desired
conclusion.

## The weaker-model test: the ceiling was the model, but Git Why is not the winner

Pre-registered in `bench/protocol.json` before any trial ran, with the
prediction and its falsifier both stated. Only the model changed:
`llmgateway/gemini-2.5-flash-lite` in place of `deepseek-v4-flash`, against
the same nine questions, six pinned corpora, grading, gold commits and budget.

**The prediction held.** Arm A fell from 100% to 28%, so the saturation seen
earlier was a property of the model rather than of the question set. Every
tool-equipped arm beat the baseline.

| arm             | cited/graded | rate |
| --------------- | ------------ | ---- |
| A baseline      | 2/7          | 28%  |
| B + zg          | 7/9          | 77%  |
| C + zg + gitwhy | 3/7          | 42%  |
| D + git why     | 4/7          | 57%  |

Two things complicate that, and the aggregate flatters Git Why without them.

**The paired evidence for Git Why is one task wide.** On tasks where both arms
produced a verdict, D beat A on `redis-01` and `redis-02`, lost on
`requests-01`, and tied three times: net +1 across six pairs. The 28% to 57%
gap reads as decisive and is not; it rests on a single task's margin at n=7.

**`zg`, not Git Why, is the strongest arm.** B scores 77%, and paired against
A it wins 3, loses 0 and ties 4 -- net +3, the cleanest signal in the run.
That is general code search rather than history retrieval. And C, holding both
tools, scores 42%: worse than either alone, matching the earlier finding that
additional tooling costs more than it returns.

So the honest conclusion, across three operating points:

- A capable model needs no retrieval tooling for these questions and is about
  twice as efficient with Git Why (16 to 9 median tool calls).
- A weaker model does benefit from retrieval tooling, but this run attributes
  the benefit mostly to `zg`, with Git Why's advantage over baseline resting
  on one task.
- The registered stopping rule applies: three operating points have now been
  tried, and no further configurations will be searched.

What this does NOT say is that Git Why retrieves badly. Its retrieval quality
is measured separately in section 4 and holds up on real repositories. What
the agent pilots measure is whether an agent NEEDS it, and on this question
set, with these two models, the answer is no for a strong model and unproven
for a weak one.

## Re-measuring temporal retrieval after the defects were fixed

The 3/15 figure that led to "temporal does not beat baseline" was measured
against a temporal path that was demonstrably broken. Every temporal query on
curl returned INTERNAL because structural expansion built a `sha IN (...)`
filter over all 30,000 commits and exceeded the storage engine's 20,000-term
limit; ordinal answers keyed on whichever token led the sentence, selecting
`http` in curl; tokenization discarded `http3` and `h3` entirely; and linked
commits could occupy every returned slot.

Those were fixed and the measurement was never repeated. Re-running the same
nine dev cases, same grading, with only the code changed:

| mode     | Hit@1         | Hit@5         | MRR           |
| -------- | ------------- | ------------- | ------------- |
| text     | 0.222 → 0.333 | 0.333 → 0.444 | 0.250 → 0.361 |
| semantic | 0.444 → 0.556 | 0.556 → 0.667 | 0.472 → 0.583 |
| hybrid   | 0.333 → 0.444 | 0.556 → 0.667 | 0.393 → 0.504 |

Hybrid MRR improves 28% relative. Each mode gains 0.111 on Hit@1 and Hit@5,
which at n=9 is one case, so the Hit@k movement is a single question changing
hands and should not be read as more than that. MRR moves across all three
modes consistently, which is the stronger signal.

Text mode improving is not an anomaly and is worth stating because it looks
like one. Temporal scoring never touches the lexical branch. What changed is
that query decomposition now feeds the retrieval branches a temporally neutral
core -- "when was HTTP/3 support first introduced in curl" becomes "HTTP/3
support in curl" -- so the FTS branch gets cleaner terms regardless of mode.
The decomposition earns its place through the core extraction, independently
of the scoring built on top of it.

This is a re-measurement after fixing known defects, not a new configuration:
the cases, split, grading and gold commits are unchanged, and the earlier run
is superseded because the code under test was crashing.

## What finally improved retrieval: lexical overlap, and a pool to rerank

Seven optimisations were measured and rejected before this one. The difference
was not a better idea; it was asking a different question. Every earlier
attempt asked "does this rank better". This one started by asking **where the
right commit actually is**.

`bench/corpus/rank-profile.mjs` requests a deep result list and records the
gold commit's position:

| gold commit rank | cases |       |
| ---------------- | ----: | ----- |
| 1                |    27 | 16.6% |
| 2-5              |    27 | 16.6% |
| 6-50             |    40 | 24.5% |
| never retrieved  |    69 | 42.3% |

That splits the misses into two problems needing opposite work. 69 are a
**recall** problem: the commit is not in the pool at all, and no reordering can
help. But 40 — a quarter of the corpus — are **retrieved and ranked badly**,
and reordering is exactly what fixes those.

**The signal.** RRF fuses the two branches by rank POSITION, which deliberately
discards magnitude; that is what makes it robust to branches whose scores are
on different scales. The cost is that a commit the lexical branch matched
strongly and one it matched barely contribute identically if they landed at the
same rank. `src/search/overlap.ts` puts a bounded amount back: the fraction of
the question's content words appearing in the commit's own subject and body,
as a multiplier in [1, 2]. Never the diff — the message is a claim about the
change as a whole, a diff hunk may be incidental.

**Validated, not fitted.** The variant was chosen by looking at the corpus, so
scoring it on the same corpus would measure how well the guess was tailored.
The weight was swept on a deterministic dev half and evaluated once on the
held-out half:

| held-out half | Hit@1 | Hit@5 |   MRR |
| ------------- | ----: | ----: | ----: |
| before        | 0.127 | 0.296 | 0.200 |
| after         | 0.183 | 0.324 | 0.252 |

+26% MRR, +44% Hit@1, on cases the weight never saw. Four other variants were
tried in the same lab — evidence count, subject-only overlap, branch agreement,
and a combination — and none survived the held-out split.

**The half that nearly hid the result.** Shipped naively, the full-corpus gain
was +0.009 MRR, a fifth of what the lab predicted, and Hit@5 went _down_. The
lab reordered the top 50; the live search sized its candidate pool to the
caller's limit, so a commit RRF put 7th was never fetched and nothing could
promote it. **A reranker needs a pool larger than its output.** With the pool at
20:

| full 174-case corpus | Hit@1 | Hit@5 |   MRR |
| -------------------- | ----: | ----: | ----: |
| before               | 0.155 | 0.287 | 0.203 |
| after                | 0.172 | 0.333 | 0.233 |

**Depth 20, not 50, and that is measured too.** Hit@5 is flat past depth 10 and
MRR has all but plateaued by 20 (0.278 against 0.281 at 50), while depth 50
cost a query without a daemon 569 ms -> 1885 ms. At 20 it is 851 ms, and 384 ms
with the daemon. Quality is the product's acknowledged ceiling and latency is
not, so paying ~50% of a query for +18% Hit@5 is the right side of that trade —
but it IS a trade, and the numbers for both sides are here rather than only the
flattering one.

**One tokenizer, not two.** The boost reuses the alphabet the rest of retrieval
uses, including the rejoin that makes `HTTP/3` and `http3` the same token.
Widening happens on the DOCUMENT side: tokenizing the question to both `http`
and `http3` would make a commit saying `http3` satisfy one requirement and fail
the other, scoring 2/3 for a full match.

## The lineage table was loaded on every query and read on almost none

The first optimisation in this project that worked, found by asking a question
the benchmark suite had never asked: not "is retrieval good" but "where does
the time go".

`Backend.search()` constructs a `JsonLineageStore` on every call, and the
constructor read and indexed the whole file eagerly. On curl that file is
**35 MB of JSON, about two seconds to parse and index**. Only ordinal and
timeline constraints ever consult it — `--first`, `--last`, `--removed`,
`--timeline` — so an ordinary `git why "..."` paid those two seconds for a
structure nothing then looked at.

The fix is two independent halves, both needed:

1. **`JsonLineageStore` loads on first lookup, not in the constructor.** The
   caller cannot know in advance whether a lookup is coming, so the store has
   to be the thing that decides.
2. **`search()` only resolves an interval when an ordinal or timeline
   constraint asks for one.** Structural expansion was already gated this way;
   this closed the last unconditional path in.

Measured on curl (30,000 commits, 182,772 records), interleaving the two builds
so drifting machine load hits both equally:

|                               |         before |         after |
| ----------------------------- | -------------: | ------------: |
| plain hybrid query, p50       |        3767 ms |       1402 ms |
| full perf workload, p50 / p95 | 3776 / 4368 ms | 807 / 1199 ms |

**4.7x on the published workload.** Output is unchanged: eleven query shapes —
plain, `--text`, `--semantic`, each ordinal, `--timeline`, `--owners`, an
anchored temporal query — produce byte-identical JSON before and after. That is
the whole safety argument, and it is why this did not need a corpus re-run:
nothing about ranking changed, a value that was computed and discarded is no
longer computed.

**What made it findable.** Every previous optimisation attempt here asked
"does this rank better". None asked "what is this spending time on". The
profile was four CLI invocations — `status`, `--text`, `--semantic`, hybrid —
which is about ten minutes of work and pointed straight at it.

**What it changes downstream.** Process start and opening the index is now
about 40% of a query rather than a small slice of a much slower one, which
makes a resident process the next real lever rather than a rounding error. See
`ROADMAP.md`.

## Ordinals are only as good as the token the interval is keyed on

Found while making the human renderer show the ordinal answer at all (it was
computed and then discarded, so nobody had looked at one outside `--json`).

On curl the answers separate sharply by kind:

| query                                                | answer                                                     | verdict |
| ---------------------------------------------------- | ---------------------------------------------------------- | ------- |
| `"when was HTTP/3 support first introduced" --first` | `3af0e76 HTTP3: initial (experimental) support` 2019-07-21 | correct |
| `"HTTP/3 support" --last`                            | `a496d46 RELEASE-NOTES: synced` 2023-02-28                 | useless |
| `"HTTP/3 support" --removed`                         | `0cafff2 RELEASE-NOTES: synced` 2023-02-20                 | wrong   |

All three are keyed on the same token, `http3`, and all three are the honest
endpoints of that token's validity interval. The problem is what the interval
covers: `RELEASE-NOTES` is regenerated wholesale every release, so the token
appears and disappears from it for reasons that have nothing to do with the
feature. `--first` survives this because the earliest commit mentioning
`http3` really is the one that introduced it; `--last` and `--removed` do not,
because the most recent appearance and disappearance are both churn.

This is why the rendered answer names its key — `(by http3)` — rather than
presenting a bare SHA. An ordinal resolved through the wrong document is
wrong in a way the SHA alone does not reveal, and a reader who can see the
key can judge it.

**Not fixed for 0.1.0, deliberately.** The obvious change is to exclude
regenerated prose files from lineage seeding, and that is a retrieval change:
it has to be measured against the 174-case corpus before shipping, because
`isProseOnlyCommit` already exists for ranking and the prose-commit penalty
built on it was measured and rejected. Making an unmeasured version of the
same idea load-bearing for ordinals late in a release is how the other seven
rejected optimisations would have gotten in.

## Where retrieval actually fails: the semantic gap, not indexing or ranking

Three hypotheses were tested against the derived corpus. Two were wrong, and
the third localises the problem precisely.

**Ranking is not the bottleneck.** recall@20 and recall@50 are identical
(0.250 aggregate). Widening the window recovers nothing, so re-ranking, RRF
tuning and score penalties can only reorder the quarter of cases that were
retrieved at all. The prose-only penalty confirmed this: a real improvement
worth 0.005 MRR and nothing more.

**The embedding model is not the bottleneck in the way expected.**
potion-retrieval-32M is tuned for prose retrieval and the questions are prose,
so it should have won. It lost on every metric (MRR 0.188 against 0.302,
recall@50 0.489 against 0.532). Commit CONTENT is code, and that dominates
what the embedder has to represent. Testing it did surface a real defect: the
candidate shipped as `available: true` but could not load, because the
tokenizer reader rejected a post_processor that Model2Vec ignores anyway.

**Pseudo-relevance feedback made it worse.** Hit@1 fell from 0.213 to 0.170
and recall@50 did not move at all. PRF needs a first pass that is roughly
right; when three quarters of first passes miss, the harvested vocabulary
comes from wrong documents and drags the second pass further away. Left
implemented behind `GIT_WHY_EXPANSION=prf` and off by default, since the
measurement is the useful part.

**The bottleneck is the semantic gap, and it is measurable.** Querying with a
commit's OWN subject retrieves it at recall@20 of 1.000 -- every commit is
indexed and reachable. Querying with the paraphrased question retrieves it at
0.280. Indexing is perfect and ranking is adequate; what fails is bridging
"why did making lots of schemas suddenly get slow and memory-hungry" to "cut
per-schema memory by moving methods to the prototype".

That is not a defect to tune away inside the retrieval stack. A static 256-
dimensional embedder cannot make that jump, and no re-ranking can recover a
document that was never retrieved. The lever is on the QUERY side: a caller
that restates the question in the vocabulary the codebase uses closes most of
the gap, and the 1.000 self-query result is the ceiling that would be
approached.

This is why the agent-facing interface matters more than another ranking
change, and it explains the earlier agent-pilot result where zg outperformed
Git Why: an agent phrases queries in code vocabulary naturally when searching
code, and had no reason to do so when searching history.

## Query restatement does not close the semantic gap either

The obvious fix for the semantic gap was to have the caller restate the
question in the codebase's vocabulary, and the first measurement looked
emphatic: Hit@1 0.296 against 0.556. It was wrong. The two rows had scored
different subsets (n=27 against n=36) because cases whose output failed to
parse were dropped independently from each, so the rows described different
questions.

Scored PAIRED, on identical cases:

| phrasing           | Hit@1 | Hit@5 | MRR   | recall@20 |
| ------------------ | ----- | ----- | ----- | --------- |
| as asked           | 0.214 | 0.500 | 0.325 | 0.571     |
| restated by caller | 0.321 | 0.321 | 0.329 | 0.393     |

Per case: restating helped 9, hurt 8, left 11 unchanged. A coin flip.

Restating sharpens the top result and destroys recall. A technical query is
narrower, so it misses documents the fuzzy question would have swept in, and
the two effects cancel: MRR moves 0.325 to 0.329.

Two claims made earlier in this session are withdrawn on this evidence.

The MCP tool description is NOT defective for inviting natural-language
questions. Natural phrasing has strictly better recall (0.571 against 0.393),
so instructing callers to restate would make retrieval worse, not better.

And the 1.000 self-query result does not bound anything reachable. Retrieving
a commit by its own subject line requires already knowing the subject, which
is the answer. It measures that indexing works; it does not describe a
ceiling any caller can approach.

Four approaches to the semantic gap have now been measured and none helped: a
prose-tuned embedding model, pseudo-relevance feedback, a prose-commit
penalty worth 0.005 MRR, and caller-side restatement. The gap looks like a
property of what a 256-dimensional static embedder can represent, not
something reachable by query or ranking changes. Closing it would mean a
larger model or a learned reranker, both of which are outside the current
dependency budget and should be proposed as such rather than smuggled in as
tuning.

What stands is the comparative result, which does not depend on any of this:
on questions cheap search provably cannot answer, Git Why scores MRR 0.201
against 0.026 for zg and 0.003 for `git log --grep`, and is the only approach
that returns anything at all for nearly every question.

## Archetype C: `git log -S` wins, and structural expansion never fires

The cross-file causal case -- a consumer does something odd because a producer
elsewhere changed, so the explaining commit never touched the file you are
reading -- is what structural expansion was built for. Measured for the first
time, on 20 mechanically extracted producer/consumer pairs in zod:

| strategy                     | Hit@1 | Hit@10 |
| ---------------------------- | ----- | ------ |
| `git log -- <consumer file>` | 0.000 | 0.000  |
| `git log -S<symbol>`         | 0.000 | 0.950  |
| git why                      | 0.100 | 0.350  |

Path-scoped history scores zero by construction, which is the archetype's
definition rather than a finding. `git log -S` dominates, and the reason is
plain: once you can NAME the symbol, pickaxe search is exactly the right
instrument, and a developer reading the consumer can see the symbol in front
of them. Git Why has no advantage over a tool given the exact literal.

That inverts cleanly against archetype A and the two together are the honest
product statement:

- You cannot name the term (fuzzy recall): Git Why, MRR 0.201 against 0.003
  for `git log --grep`.
- You can name the term: `git log -S`, Hit@10 0.950 against 0.350.

Two defects were found while measuring, and the first invalidated a whole run.

The extractor initially accepted generic symbols (`schema`, `branch`) and
documentation files as consumers, producing pairs like "why does api.mdx need
schema" whose answer was an unrelated regex change. `-S` on a ubiquitous word
matches coincidence, not causation. Symbols must now be distinctive (eight
characters or more, mixed case, appearing in between two and twelve commits)
and consumers must be source files.

And structural expansion never fires at all. It is gated on
`constraint.type !== 'none'`, so a question with no temporal phrasing -- which
every cross-file question is -- takes the ordinary path. Lifting that gate
behind GIT_WHY_EXPAND_ALWAYS changed nothing, because the hot-path filter
excludes any path touched by more than 2% of commits: 64 commits in zod, and
in a monorepo the main source files are edited far more often than that. Every
candidate path is hot, so nothing links. The filter added to suppress noise
suppressed the mechanism.

That is a real defect with a named cause, not a limitation. Fixing it means a
frequency cutoff that adapts to how a repository is laid out rather than one
flat fraction, and the measurement above is the baseline it has to beat.

### Making expansion work, and finding it still does not help

Two defects kept structural expansion from ever producing a result, and both
are now fixed. It still loses, which is the useful part.

The path filter excluded any key touched by more than 2% of commits. On zod
that is 64, and its main source files are edited far more often, so every
candidate path was excluded and `linkedCommits` had nothing to work with.
Replaced with inverse-document-frequency weighting: sharing a rarely-touched
path is strong evidence of a relationship, sharing a file everyone edits is
almost none, and that is a gradient rather than a cliff.

The deeper defect was arithmetic. A linked commit scores its seed's score
times a hop discount, so it ranks BELOW the seed that produced it by
construction. With enough seeds to fill the page -- the normal case -- links
could never place, and a "cap" on how many could appear was meaningless
because the cap was unreachable. Expansion had returned zero linked commits on
every query ever asked of it. Links now get reserved slots and are judged
against each other, since the entire point is to surface commits retrieval
missed, and those cannot be expected to outrank the ones it found.

With both fixed, expansion demonstrably fires: three linked commits in a
ten-result page. Measured on the cross-file corpus it makes things WORSE,
Hit@10 falling from 0.350 to 0.250, because the reserved slots displace seeds
that contained the answer more often than the links do.

So it stays off by default, which is where it already was -- but for a
measured reason now rather than an accidental one. The machinery is correct
and available behind GIT_WHY_EXPAND_ALWAYS for anyone who wants to re-test it
against a different corpus.

The path-weighting change did help the main corpus slightly on its own:
Hit@5 0.183 to 0.200, MRR 0.128 to 0.131.

### Fusing both phrasings: best recall, worst precision

Restating helps Hit@1 and hurts recall, so fusing the natural question with
its restatement should have captured both. `--group` with commit-level RRF
already exists for this. Measured on the same 28 paired zod cases:

| phrasing      | Hit@1 | Hit@5 | MRR   | recall@20 |
| ------------- | ----- | ----- | ----- | --------- |
| as asked      | 0.214 | 0.500 | 0.325 | 0.571     |
| restated only | 0.321 | 0.321 | 0.329 | 0.393     |
| fused (both)  | 0.250 | 0.286 | 0.293 | 0.607     |

Fusing does deliver the best recall of the three, and the worst MRR. RRF
spreads rank mass across two result sets, so the correct commit is found more
often and sits lower when it is.

That is worth knowing for a caller that will read every result -- an agent
with twenty hits to skim gains from the extra recall -- but it is not a better
default, and it is offered rather than adopted.

Seven query-side and ranking-side techniques have now been measured: a
prose-tuned embedding model, pseudo-relevance feedback, a prose-commit
penalty, caller restatement, wider result windows, structural expansion, and
phrase fusion. None improves MRR over asking the question plainly. The
shipped default is the best configuration among everything tried, which is a
duller result than a tuning win and a more useful one: there is no easy gain
being left on the table, and the remaining headroom is in the embedding
itself.
