# Git Why — handoff

Written 2026-09-09. Records where the work actually stands, what is measured
versus assumed, and what to do next. Anything here that is a number was
measured; anything that is a guess says so.

Repository: https://github.com/alliecatowo/git-why
HEAD at writing: `a896d35` on `main`.

## 1. What the product is

`git blame` tells you who changed a line. Git Why finds the commits that
explain why. Hybrid retrieval (BM25 + static embeddings) over commit messages
and diff hunks, fused with Reciprocal Rank Fusion at the commit level, stored
in an in-process Zvec database under `.git/why/`. No daemon, no server, no
network at query time.

Embeddings are Model2Vec static vectors (`minishlab/potion-code-16M-v2`, 256
dimensions, F16), implemented by hand because no npm package exists. There is
no transformer forward pass at query time; that is why queries are fast and
why indexing is CPU-cheap relative to a real encoder.

## 2. Current state by area

### Landed and green

- **Repository hygiene.** Benchmark scratch state lives under `BENCH_WORK_DIR`
  (default `~/.cache/git-why-bench/<hash-of-repo-path>/`), outside any git
  worktree. `bench/work/` is deleted. `test/unit/no-benchmark-artifacts.test.ts`
  fails the build if it returns or if a task file lands in `src/`.
- **Temporal type contract** (`src/types.ts`). Frozen. `TemporalConstraint`,
  `QueryDecomposition`, `OrdinalAnswer`, `TimelineEpisode`, `HitScores`,
  `LineageInterval`, `LineageStore`. `MatchedBy` gained `linked`.
- **JSON envelope at schemaVersion 2**, both search and status schemas moved
  together. Adds `coreQuery`, `temporal`, `answer`, `timeline`, per-result
  `scores` and `linkDistance`.
- **Protocol v2** (`bench/protocol.json`), frozen at
  `sha256:458142672d4746ff366fb22a9c0d44f4b0a82f7fbc3cc74c7f021a41dc5773df`,
  verified on every `npm run check` by `bench/freeze-protocol.mjs`.
- **Temporal core** (`src/search/temporal/{intent,score,tuning}.ts`), 27 tests.
  Pure functions, not yet wired into the pipeline.
- 325 unit tests, 65 integration tests (1 skipped: non-UTF-8 filenames, APFS
  rejects them).

### In flight

A single sonnet agent (`finisher`) owns the whole remaining brief. There is
uncommitted Part-A work in the tree from a previously killed agent:
`install.sh`, `package.json`, `scripts/verify-package.mjs`,
`src/cli/{args,main,wire}.ts`, `src/index/status.ts`, plus untracked `man/`
and `scripts/gen-man.mjs`. It needs triage, not blind adoption.

### Not started

The lineage table, structural expansion, ordinal/timeline resolution, the CLI
temporal flags, the MCP temporal schema, the benchmark harness rebuild, the
task rebuild, the smoke gate, and every benchmark run under protocol v2.

## 3. Measured numbers

Every number below was measured on this machine. None is estimated.

### Retrieval, protocol v1

| Metric | Synthetic (dev/test)   | Real (express + axios) | external-v2 (six repos) |
| ------ | ---------------------- | ---------------------- | ----------------------- |
| Hit@5  | 100% (saturated)       | 90%                    | 50%                     |
| Hit@1  | —                      | 60%                    | —                       |
| MRR    | 0.778 dev / 0.944 test | 0.733                  | 0.358                   |

Hit@5 saturates on the synthetic fixtures and does not discriminate between
retrieval modes. Read MRR as the quality signal. The external-v2 numbers are
the honest ones and are what the README must lead with.

"When was X first introduced" probes on external-v2 scored **4 of 15 at
Hit@1**. That is the baseline the temporal work has to beat.

### Index size and build time — the current headline problem

Measured on the six pinned external clones:

| Repo     | Commits | Index size | KB/commit | Build time |
| -------- | ------- | ---------- | --------- | ---------- |
| curl     | 30,000  | 1.3 GB     | ~43       | 804s       |
| redis    | 12,110  | 1.0 GB     | ~83       | 473s       |
| requests | 6,494   | 128 MB     | ~20       | 58s        |
| zod      | 3,210   | 315 MB     | ~98       | 87s        |
| caddy    | 2,680   | 290 MB     | ~108      | 83s        |
| ripgrep  | 2,287   | 108 MB     | ~47       | 34s        |

Total for one full pass over all six: about 26 minutes of wall clock for
56,781 commits. That is the cost of every re-index, which is why the disk fix
and the lineage table must both land before the next indexing pass.

Target is under 8 KB/record. This is 5–13× over. What dominates has **not**
been measured yet — Zvec collection files versus the jsonl versus duplicated
evidence text. Do that measurement before attempting a fix.

Earlier smaller measurements, for reference: express 6,167 commits in 52s at
126.3 MiB; axios 2,185 commits in 26s at 80.8 MiB. Fresh-process warm query
p50/p95 was 496/509 ms over 30 samples.

### Ablation

On synthetic fixtures, diff/evidence ingestion did not clearly earn its
complexity (hybrid ΔHit@5 −0.111, ΔMRR +0.019). **Do not act on this.** The
user was explicit that diff must not be dropped on synthetic evidence alone,
and that the decision must be science-informed across real repositories. The
real-history ablation has not been run.

## 4. The bug worth remembering

Zvec's `COSINE` metric returns a **distance** (lower is closer), but
`ScoredRecord.score` is defined as higher-is-better and the ranking layer
sorts on it that way. The vector branch was feeding raw distance straight
through, so semantic search ranked the _least_ relevant commits first. Nothing
downstream surfaced this as an error — only as bad results.

It was caught by noticing top-k scores were _ascending_ (0.568, 0.590, 0.600).
Fixed at the adapter boundary in `src/index/collection.ts` with
`similarityFromCosineDistance`. Semantic Hit@5 went 0% → 92%, hybrid → 100%.

The lesson generalizes: a scoring convention mismatch is invisible to types
and to tests that only assert "results came back". Assert on _ordering_.

## 5. Temporal design, and why

Full rationale in `docs/research/temporal-retrieval-dossier.md`; the spec is
`docs/spec.md` section 14a. The short version:

The observed failure is not a ranking failure. The originating commit is
usually terse — "add vquic", "initial streams" — and never enters the
candidate pool at all. No amount of re-sorting, date filtering, or widening
`n` recovers a commit that was never retrieved.

1. **Vectors locate the topic; the commit DAG resolves time.** Timestamps are
   never embedded.
2. **`none` is the identity constraint**, not a missing value. Temporal score
   is exactly 1, exponent exactly 0, expansion disabled, ranking bit-identical
   to the pre-temporal path. Re3 measures recall@1 falling from 0.742 to 0.268
   under a fixed relevance/recency weight — an always-on recency prior is a
   known failure mode, not a safe default.
3. **`final = fusedRRF * temporal ** w`**, `w` = 1.0 explicit / 0.5 inferred /
   0 none. Confidence scales the exponent rather than gating the term, so a
   misparsed intent costs rank instead of the result set.
4. **Ordinals come from ancestry, never timestamps.** Rebases and cherry-picks
   rewrite committer time, and they do it on exactly the repositories where
   the question is worth asking.
5. **The pool grows by structure, not by a wider top-k.** Lineage-linked
   commits enter tagged `linked` with a hop-count discount.
6. **`answer` is reported separately from `results`.** "This is where it first
   appears" is a different claim from "these commits are relevant"; merging
   them would let a confident wrong ordinal pass as a retrieval result.

### Open design questions

- How large does the lineage table get on curl? It is keyed by distinct
  identifier tokens, so it scales with vocabulary, not commits. Measure before
  building all six.
- Should "removed" prefer the commit that deleted the _last_ occurrence or the
  _first_ deletion of any occurrence? Probably the last; verify on real cases.
- Merge commits: first-parent lineage for ordinals, or the merge itself?
  Squash-merge and merge-commit repositories will differ.
- Should inferred intent change ranking at all, or only add `answer` plus a
  hint? Measure both on dev.

## 6. Indexing cost — sequence carefully

Three things could each force a re-index: the disk-overhead fix, the lineage
table, and any later format change. Naively that is three passes over 56,781
commits.

**The lineage table must be an additive, independent pass.** It is derived
from git history, not from embeddings, so building it must not require
re-embedding. `git why index` against a current generation with a missing or
stale lineage table should build only the lineage table.

**Land the disk fix and the lineage table before indexing anything.** Then one
indexing pass over the six repos, then the benchmarks.

## 7. The invalid agent pilot

`bench/results/agents/pilot-2026-09-09T23-13-53-652Z` is **deleted**, not
superseded. Do not cite it. Eight independent harness defects:

1. OpenCode re-rooted every session from the trial clone to the outer git-why
   repository. Clones lived inside the repo tree and `--dir` was never passed.
2. `git why` had no index in any trial workspace. The usage card claimed a
   prebuilt frozen index and mandated `--no-refresh`; the runner never built
   one. Every search returned `INDEX_MISSING`. `zg` was never used.
3. Agents could read hidden tests, rubrics, manifests, specs, gold-bearing
   source repos, other trials' clones, and the de-blinding index.
4. Agents wrote task answers into the real repository. `src/utils.cjs` (a T7
   answer) was committed in `6d3205e`, which is why T7 failed everywhere.
5. Task repos had 3 commits each and the prompts contained the answers.
   Nothing discriminated between arms.
6. Token accounting read only the final `step_finish` event: 69k recorded
   against 2.56M real input tokens. `git_why_calls` and `zg_calls` were
   hardcoded null. Raw events were never persisted.
7. The model was not the calibrated one, and it was billed.
8. `summary.json` mixed rubric trials (`pass=null`) into per-arm pass counts.

Root cause 1 is fixed structurally (scratch state is outside any worktree).
The rest are the subject of Parts C–E of the current brief.

Separately: the **v1 `protocolHash` was a literal string with no generator**.
Re-deriving it from v1 content yields a different digest, so it never
certified anything. `bench/freeze-protocol.mjs` fixes this and `npm run check`
enforces it.

## 8. Hard gates

- Non-temporal dev MRR must be unchanged within **0.005 absolute** before any
  claim that temporal retrieval helps. A golden test must assert byte-identical
  ranking for non-temporal queries.
- The held-out split runs **exactly once** under the protocol v2 hash. If a
  tuning script ever reads `bench/dataset/test.json`, the holdout is burned and
  a new one must be constructed.
- Tuning constants live only in `src/search/temporal/tuning.ts` and are fitted
  on `bench/dataset/dev.json` only.
- An 8–20 task pilot is descriptive evidence. No significance claims.
- Negative and null results are reported as plainly as positive ones.

## 9. Environment

- Toolchain pinned by `mise.toml` (node 24.21.0, gh 2.100.0, `mise.lock`).
- `zg` (Zvec-Grep) 0.2.2 installed; `git why doctor` reports it.
- npm package is `@alliecatowo/git-why` (the bare `git-why` name is taken); the
  binary name is unchanged.
- `git why --help` is intercepted by Git itself, which redirects to
  `man git-why`. That is what the man page work exists to fix. `-h` works.
- Six external repos cloned and indexed at pinned cutoffs under
  `$BENCH_WORK_DIR/external/`, HEAD-verified, commit counts matching
  `bench/dataset/external-v2.json`.

## 10. Commands

```
mise run check              # format, lint, typecheck, protocol hash, unit tests
npm run test:integration
node bench/freeze-protocol.mjs          # verify protocol hash
node bench/freeze-protocol.mjs --write  # re-freeze (invalidates prior holdout runs)
node bench/retrieval/run.mjs --split=dev
node bench/retrieval/run-external.mjs --repos=$BENCH_WORK_DIR/external --dataset=bench/dataset/external-v2.json
node bench/agents/run.mjs --stage=smoke
node bench/report.mjs       # regenerates docs/report.md from raw results only
```

Never hand-edit a number in `docs/report.md` or the README. Both are generated.
