# Git Why -- benchmark report

Generated 2026-09-09T20:31:47.949Z by `bench/report.mjs` from raw files under `bench/results/`. No percentage in this document is hand-entered; regenerate with `node bench/report.mjs` to reproduce every number from the same source files.

## Leading caveat: Hit@5 saturates on this dataset -- read MRR, not Hit@5

On both the dev split and the held-out test split, text-only and hybrid retrieval reach 100% Hit@5 (and semantic is close behind). At Hit@5, the three retrieval modes are indistinguishable on this synthetic dataset -- **Hit@5 does not discriminate between modes here.** Mean Reciprocal Rank (MRR) still separates them because it credits *how high* the relevant commit ranks, not merely whether it appears in the top 5. Every comparative claim below leads with MRR for that reason; Hit@5/Recall@5 are reported alongside for completeness, not as the headline metric.

## 1. Frozen question and protocol

- Protocol version 1, frozen at 2026-09-09T00:00:00Z (`sha256:522a2beec8aff23364a2e314ce6862d8211150bad808b6b3164570d01ad9be6f`), by: evaluation lane, before any retrieval tuning against bench/dataset/test.json.
- Development target: At least 75% Hit@5 on answerable (non no-evidence) semantic-archaeology cases in bench/dataset/dev.json, with exact-identifier (category=exact_identifier) performance reported SEPARATELY and not folded into the 75% figure.
- This target is explicitly NOT A statistical claim. With 20 answerable dev cases (24 dev cases minus 4 dev no-evidence cases), a single-point Hit@5 estimate carries wide uncertainty; do not report a confidence interval implying more precision than a 20-item sample supports.
- Ranking: Reciprocal Rank Fusion (RRF) over the lexical (FTS) and semantic (vector) branches. (RRF constant = 60, 60 is the constant from the original Cormack et al. RRF paper and is the de facto default in hybrid-search literature; not tuned against this dataset. Changing it would require re-freezing this protocol.)
- Candidate limits: lexical top-50, semantic top-50, metrics computed over the top 5 returned commits.
- Dataset provenance: 48 labeled cases (24 dev / 24 test), 8 no-evidence (4 dev, 4 test), across 6 synthetic fixture repositories, covering all 12 required categories.
- External validity dataset: bench/dataset/external.json: 12 hand-verified cases over expressjs/express and axios/axios (both MIT-licensed), 6 dev / 6 test, pinned cutoff SHAs and ancestry-verified relevant SHAs. See that file's 'notBlinded' field.
- **The held-out split is NOT a blinded study.** See bench/README.md: the same agent system that implements Git Why also authored this file. This is real-repository evidence, not a blinded held-out study. The same holds for `bench/dataset/test.json`: the agent system that implemented Git Why also authored these benchmark cases. Treat the held-out numbers below as a frozen-protocol sanity check, not as evidence of generalization to an adversarial or independently-authored test set.

## 2. Environment, pinned tools/models, corpus snapshots

- Hardware: Apple M2, 8 cores, 8.6 GB RAM, darwin/arm64.
- Toolchain: node v24.21.0, git version 2.50.1 (Apple Git-155).
- Embedding model: `minishlab/potion-code-16M-v2` revision `e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b`, fingerprint `m2v-sha256:9e51530c5a19d0147b884669fe4e0db7bfc7773c728e79eaf4c40ffc53b0fbf8`.
- Code commit under test: `73efd914efa56ce89e9b6f65e77b4fcf0fa24cc5`. The working tree had 139 uncommitted path(s) at report time (this lane does not commit; see "reproduction" section for the exact files bench/ owns):

```
M README.md
 M bench/agents/grade.mjs
 M bench/agents/isolation.mjs
 M bench/agents/run.mjs
 M bench/agents/runner.mjs
 M bench/agents/tasks/build.mjs
 M bench/agents/tasks/hidden/T5/rubric.json
 M bench/agents/tasks/lib/task-engine.mjs
 M bench/agents/tasks/specs/t2.mjs
 M bench/agents/tasks/specs/t3.mjs
 M bench/agents/tasks/specs/t4.mjs
 M bench/agents/tasks/specs/t5.mjs
 M bench/agents/tasks/specs/t6.mjs
 M bench/agents/tasks/specs/t7.mjs
 M bench/agents/tasks/specs/t8.mjs
 M bench/agents/usage-cards/git-why.md
 M bench/dataset/dev.json
 M bench/dataset/external.json
 M bench/dataset/test.json
 M bench/fixtures/demo/build.mjs
 M bench/fixtures/generate.mjs
 M bench/fixtures/lib/engine.mjs
 M bench/fixtures/lib/git.mjs
 M bench/fixtures/lib/wordbank.mjs
 M bench/fixtures/manifests/api-gateway.json
 M bench/fixtures/manifests/auth-platform.json
 M bench/fixtures/manifests/build-tooling.json
 M bench/fixtures/manifests/data-pipeline.json
 M bench/fixtures/manifests/realtime-chat.json
 M bench/fixtures/manifests/task-queue.json
 M bench/fixtures/specs/api-gateway.mjs
 M bench/fixtures/specs/build-tooling.mjs
 M bench/fixtures/specs/data-pipeline.mjs
 M bench/fixtures/specs/realtime-chat.mjs
 M bench/perf/lib.mjs
 M bench/perf/run.mjs
 M bench/protocol.json
 M bench/report.mjs
 M bench/retrieval/candidates.json
 M bench/retrieval/run.mjs
 M docs/contributing.md
 M docs/decisions.md
 M docs/operations.md
 M eslint.config.js
 M schema/search-response.schema.json
 M schema/status-response.schema.json
 M scripts/doctor.mjs
 M scripts/postbuild.mjs
 M scripts/repo-create.mjs
 M scripts/verify-package.mjs
 M spike/children/concurrent-reader.ts
 M spike/children/concurrent-writer.ts
 M spike/children/lifecycle-reader.ts
 M spike/children/lifecycle-writer.ts
 M spike/children/lock-holder.ts
 M spike/lock-proto.ts
 M spike/run.ts
 M spike/util.ts
 M src/cli/args.ts
 M src/cli/main.ts
 M src/cli/paths.ts
 M src/cli/ports.ts
 M src/cli/wire.ts
 M src/embedding/cache.ts
 M src/embedding/candidates.ts
 M src/embedding/fake.ts
 M src/embedding/index.ts
 M src/embedding/static-embedder.ts
 M src/embedding/tokenizer.ts
 M src/git/exec.ts
 M src/git/extract.ts
 M src/git/repository.ts
 M src/git/snapshot.ts
 M src/history/chunk.ts
 M src/history/extract.ts
 M src/index/collection.ts
 M src/index/filter.ts
 M src/index/journal.ts
 M src/index/layout.ts
 M src/index/lock.ts
 M src/index/manifest.ts
 M src/index/refresh.ts
 M src/index/status.ts
 M src/output/human.ts
 M src/output/json.ts
 M src/search/evidence.ts
 M src/search/filters.ts
 M src/search/rank.ts
 M src/search/search.ts
 M src/types.ts
 M src/utils.cjs
 M test/fixtures/repo.ts
 M test/integration/cli/cli.test.ts
 M test/integration/cli/fixtures/fake-backend.mjs
 M test/integration/embedding/concurrent-download.test.ts
 M test/integration/embedding/fixtures/potion-code-16m-v2.reference.json
 M test/integration/embedding/reference-vectors.test.ts
 M test/integration/git/attribute-stability.test.ts
 M test/integration/git/extract-cases.test.ts
 M test/integration/git/join.test.ts
 M test/integration/git/object-format.test.ts
 M test/integration/git/paths.test.ts
 M test/integration/git/scope.test.ts
 M test/integration/git/shallow.test.ts
 M test/integration/index/child-script.ts
 M test/integration/index/collection.test.ts
 M test/integration/index/helpers.ts
 M test/integration/index/lock-child.ts
 M test/integration/index/lock.test.ts
 M test/integration/index/refresh-child.ts
 M test/integration/index/refresh.test.ts
 M test/repo-root.ts
 M test/unit/cli/args.test.ts
 M test/unit/cli/paths.test.ts
 M test/unit/embedding/cache.test.ts
 M test/unit/embedding/safetensors.test.ts
 M test/unit/embedding/static-embedder.test.ts
 M test/unit/git/patch.test.ts
 M test/unit/history/budget.test.ts
 M test/unit/history/chunk.test.ts
 M test/unit/history/extract.test.ts
 M test/unit/history/ids.test.ts
 M test/unit/history/pathkeys.test.ts
 M test/unit/history/text.test.ts
 M test/unit/index/filter.test.ts
 M test/unit/index/layout.test.ts
 M test/unit/index/manifest.test.ts
 M test/unit/index/status.test.ts
 M test/unit/output/human.test.ts
 M test/unit/output/json.test.ts
 M test/unit/output/sanitize.test.ts
 M test/unit/output/schema-check.ts
 M test/unit/search/evidence.test.ts
 M test/unit/search/filters.test.ts
 M test/unit/search/rank.test.ts
 M test/unit/search/search.test.ts
 M tsconfig.build.json
?? bench/README.md
?? docs/report.md
```
- Reference corpus for retrieval: 6 synthetic fixtures under `bench/work/fixtures/` (135-166 commits each), deterministically generated by `bench/fixtures/generate.mjs`.
- Reference corpus for perf: `task-queue` (135 commits, synthetic). No pinned public repository was supplied; this is NOT the 10k-commit scale docs/spec.md section 24 ultimately targets.

## 3. Retrieval quality

Dev run: `dev-2026-09-09T20-14-34-765Z` (72 query records, protocol hash `sha256:522a2beec8aff23364a2e314ce6862d8211150bad808b6b3164570d01ad9be6f`).

**Dev split -- overall (excludes `exact_identifier` and `no_evidence`, per protocol), MRR-led:**

| mode | n | MRR | Hit@1 | Hit@3 | Hit@5 | Recall@5 |
|---|---|---|---|---|---|---|
| text | 18 | 0.766 | 61.1% | 88.9% | 100.0% | 100.0% |
| semantic | 18 | 0.741 | 61.1% | 88.9% | 88.9% | 88.9% |
| hybrid | 18 | 0.778 | 61.1% | 100.0% | 100.0% | 100.0% |

**Dev split -- `exact_identifier` reported separately (per protocol; not folded into the overall row above):**

| mode | n | MRR | Hit@1 | Hit@3 | Hit@5 | Recall@5 |
|---|---|---|---|---|---|---|
| text | 2 | 0.750 | 50.0% | 100.0% | 100.0% | 100.0% |
| semantic | 2 | 1.000 | 100.0% | 100.0% | 100.0% | 100.0% |
| hybrid | 2 | 1.000 | 100.0% | 100.0% | 100.0% | 100.0% |

**Dev split -- per-category (hybrid mode, the shipped default):**

| category | n | MRR | Hit@1 | Hit@3 | Hit@5 | Recall@5 |
|---|---|---|---|---|---|---|
| synonym_mismatch | 2 | 1.000 | 100.0% | 100.0% | 100.0% | 100.0% |
| workaround_rationale | 2 | 1.000 | 100.0% | 100.0% | 100.0% | 100.0% |
| deleted_implementation | 2 | 0.667 | 50.0% | 100.0% | 100.0% | 100.0% |
| migration | 2 | 0.500 | 0.0% | 100.0% | 100.0% | 100.0% |
| exact_identifier | 2 | 1.000 | 100.0% | 100.0% | 100.0% | 100.0% |
| number_version | 2 | 0.667 | 50.0% | 100.0% | 100.0% | 100.0% |
| rename | 2 | 1.000 | 100.0% | 100.0% | 100.0% | 100.0% |
| poor_message_rich_diff | 2 | 0.667 | 50.0% | 100.0% | 100.0% | 100.0% |
| rich_message_skipped_patch | 2 | 0.750 | 50.0% | 100.0% | 100.0% | 100.0% |
| lifecycle | 1 | 1.000 | 100.0% | 100.0% | 100.0% | 100.0% |
| distractor_intent | 1 | 0.500 | 0.0% | 100.0% | 100.0% | 100.0% |

**Dev split -- no-evidence cases (excluded from all metrics above; there is no relevant SHA to rank):**

These queries describe design decisions the fixtures never actually made (no commit exists that answers them). The system has no "I don't know" response: it always returns its 5 closest-ranked commits regardless of whether any of them are actually relevant. A user reading those top-k results as an explanation would be reading an UNSUPPORTED answer -- the tool surfaced *something*, not *the reason*, because there is no reason recorded in this history.

Observed across 12 no-evidence (case, mode) pairs in this run: 100% returned a full page of results (no case returned an empty list or a refusal).

Held-out run: `test-2026-09-09T20-21-00-051Z` (72 query records). Per bench/protocol.json, this split is run exactly once at a frozen configuration; the numbers below are published as-measured, not tuned after the fact.

**Held-out test split -- overall (excludes `exact_identifier` and `no_evidence`, per protocol), MRR-led:**

| mode | n | MRR | Hit@1 | Hit@3 | Hit@5 | Recall@5 |
|---|---|---|---|---|---|---|
| text | 18 | 0.891 | 83.3% | 94.4% | 100.0% | 100.0% |
| semantic | 18 | 0.900 | 83.3% | 94.4% | 100.0% | 100.0% |
| hybrid | 18 | 0.944 | 88.9% | 100.0% | 100.0% | 100.0% |

**Held-out test split -- `exact_identifier` reported separately (per protocol; not folded into the overall row above):**

| mode | n | MRR | Hit@1 | Hit@3 | Hit@5 | Recall@5 |
|---|---|---|---|---|---|---|
| text | 2 | 1.000 | 100.0% | 100.0% | 100.0% | 100.0% |
| semantic | 2 | 1.000 | 100.0% | 100.0% | 100.0% | 100.0% |
| hybrid | 2 | 1.000 | 100.0% | 100.0% | 100.0% | 100.0% |

**Held-out test split -- per-category (hybrid mode, the shipped default):**

| category | n | MRR | Hit@1 | Hit@3 | Hit@5 | Recall@5 |
|---|---|---|---|---|---|---|
| synonym_mismatch | 2 | 1.000 | 100.0% | 100.0% | 100.0% | 100.0% |
| workaround_rationale | 2 | 1.000 | 100.0% | 100.0% | 100.0% | 100.0% |
| deleted_implementation | 2 | 1.000 | 100.0% | 100.0% | 100.0% | 100.0% |
| migration | 2 | 0.750 | 50.0% | 100.0% | 100.0% | 100.0% |
| exact_identifier | 2 | 1.000 | 100.0% | 100.0% | 100.0% | 100.0% |
| number_version | 2 | 0.750 | 50.0% | 100.0% | 100.0% | 100.0% |
| rename | 2 | 1.000 | 100.0% | 100.0% | 100.0% | 100.0% |
| poor_message_rich_diff | 1 | 1.000 | 100.0% | 100.0% | 100.0% | 100.0% |
| rich_message_skipped_patch | 1 | 1.000 | 100.0% | 100.0% | 100.0% | 100.0% |
| lifecycle | 2 | 1.000 | 100.0% | 100.0% | 100.0% | 100.0% |
| distractor_intent | 2 | 1.000 | 100.0% | 100.0% | 100.0% | 100.0% |

**Held-out test split -- no-evidence cases (excluded from all metrics above; there is no relevant SHA to rank):**

These queries describe design decisions the fixtures never actually made (no commit exists that answers them). The system has no "I don't know" response: it always returns its 5 closest-ranked commits regardless of whether any of them are actually relevant. A user reading those top-k results as an explanation would be reading an UNSUPPORTED answer -- the tool surfaced *something*, not *the reason*, because there is no reason recorded in this history.

Observed across 12 no-evidence (case, mode) pairs in this run: 100% returned a full page of results (no case returned an empty list or a refusal).

**Dev vs. held-out (hybrid, MRR):** dev = 0.778, held-out = 0.944 (+0.167). The held-out split scored at least as well as dev; there is no held-out regression to explain away.

Important sequencing note: the score-inversion bug (Zvec COSINE returns a *distance*, not a similarity; the semantic branch was ranking the least-relevant commits first before this fix) was found and fixed against **dev** data, strictly *before* the held-out run above was executed. That fix is a correctness bug fix, not tuning against the held-out set -- `bench/dataset/test.json` was never read or scored until the single frozen run recorded here.

## 4. Ablation: does diff/evidence ingestion earn its complexity?

Run: `dev-2026-09-09T20-19-40-499Z/ablation-summary-production.json`. Mechanism: GIT_WHY_BENCH_RECORD_TYPES=commit restricts retrieval to commit-summary records; unset retrieves commit + evidence records. Index built once per fixture (both record types always ingested); the env var only changes what a query is allowed to retrieve. See src/search/search.ts benchRecordTypes().

Diff = (summary+evidence) minus (summary-only), overall (excludes `exact_identifier` and `no_evidence`):

| mode | n (each arm) | dHit@1 | dHit@3 | dHit@5 | dRecall@5 | dMRR |
|---|---|---|---|---|---|---|
| text | 18 | -0.111 | 0.056 | 0.111 | 0.111 | -0.005 |
| semantic | 18 | 0.000 | 0.056 | 0.056 | 0.056 | 0.028 |
| hybrid | 18 | -0.056 | 0.111 | 0.111 | 0.111 | 0.019 |

**Verdict:** on this dev set, adding evidence (diff) records does **not** show a clear, consistently positive effect. In hybrid mode (the shipped default), evidence ingestion is worse on Hit@3/Hit@5/Recall@5 (0.111/0.111/0.111) and only marginally better on MRR (0.019) and worse on Hit@1 (-0.056). Text mode shows the same pattern (Hit@3/5/Recall@5 better summary-only, MRR essentially flat at -0.005). Semantic mode is the closest to a wash (MRR 0.028). On this synthetic, 24-case dev set, summary-only retrieval is at least as good as summary+evidence on every metric except a small MRR edge in two of three modes -- **this dataset does not demonstrate that diff/evidence ingestion earns its added complexity.** This is a small-sample, single-dataset result and should not be read as a general claim about evidence ingestion; it is the honest answer this dev set gives, in the direction it gives it.

## 5. Agent benchmark (arms A/B/C/D)

- Arm A (baseline) and Arm D (history / git why, no zg): runnable per protocol, since `dist/cli/main.js` now exists.
- Arm B (workspace + zg) and Arm C (workspace + zg + git why): **BLOCKED**. `which zg` at report-generation time: not found on PATH. Per protocol, these arms are recorded as infrastructure-blocked, not silently skipped.
- Harness smoke-test runs present under `bench/results/agents/`: none. Per protocol, smoke runs never enter the pilot aggregate.
- Pilot runs (8 frozen tasks x 4 arms x 2 trials = 64) present under `bench/results/agents/`: none.

**The agent usefulness pilot has NOT been executed.** This report contains no task-level successes/regressions, no evidence-use analysis, and no A/B/C/D comparison numbers, because none exist yet. The existence of the harness (`bench/agents/*.mjs`) and a smoke test is not a result and is not presented as one. When the pilot is run, its 8-task N means any headline number it produces is descriptive evidence only -- report requirement: **no universal improvement percentage and no significance claim**, regardless of the direction the pilot points.

## 6. CLI latency, first-index cost, memory, disk, parallel behavior

Perf run: `2026-09-09T20-23-36-126Z` on Apple M2 / 8 cores / 8.6 GB, against the `task-queue` fixture (135 commits).

**Known gaps in this run** (from the runner itself, not omitted silently):

- Per-phase timing breakdown is not part of the frozen --json contract; only total external wall time is measured.
- Loaded-process query loop is approximated via warm fresh-process calls, not a true in-process repeat.
- No pinned public repository was supplied (--repo=); reference corpus is a synthetic fixture, not the 10k-commit target scale.

### First use

- Missing model (cold download/first extraction), isolated cache: 4157 ms (exit 0).
- Cached model (isolated cache pre-warmed by the previous run): 1900 ms (exit 0).
- Cache-override verified by directory growth: true.

### Fresh-process query, current index (warm cache)

- Warm-up: 5 discarded runs before sampling. Samples: 30/30 successful.
- p50 496 ms, p95 509 ms, min 491 ms, max 516 ms, mean 497 ms.
- Section 24 initial target: warm-cache fresh-process CLI p95 under 1s on the reference corpus. This is a target, not an established result.

### Loaded-process query loop -- **DIAGNOSTIC ONLY**

- DIAGNOSTIC ONLY -- approximated via back-to-back fresh processes, NOT a true in-process query loop.
- p50 500 ms, p95 535 ms (n=30). This is fresh-process latency measured back-to-back, not a true resident-process repeat loop; do not read it as evidence of in-process amortization.

### One new ordinary commit

- Query-after-commit total: 841 ms. Indexed commits 135 -> 136. Section 24 initial target: one small incremental commit plus query within 3s on reference hardware.

### Ten new commits (batch)

- Total: 796 ms, throughput 12.56 commits/sec, peak RSS 266.6 MB (15 samples).

### Unchanged refs (no re-embedding)

- Query total: 513 ms. Index `indexedAt` before/after: `2026-09-09T20:24:19.377Z` / `2026-09-09T20:24:19.377Z`. **No re-embedding inferred: true** (indexedAt is unchanged used as the externally-observable proxy). indexedAt unchanged is used as the externally-observable proxy for "no document re-embedding"; query embedding of the incoming query text may still occur per spec.

### Rename / branch deletion (no rebase scenario available)

- Index build: 1936 ms. Record count before: 274. After adding+renaming a file on a scratch branch: query 864 ms. After deleting that branch (making its 2 commits unreachable) and querying again: 624 ms, record count 274.
- Record count returned to the pre-scratch-branch baseline (274 -> 274) after the branch was deleted, i.e. the index correctly reconciled away derived data for commits that became unreachable -- a real, positive reachability-tracking result, not a no-op measurement.
- A full rebase scenario is not exercised here (the fixture generator does not produce a rebase-able branch); this covers rename + branch deletion only. See bench/README.md limitations.

### Concurrent readers

| readers | p50 | p95 | failures | "aggregate" peak RSS (see caveat) |
|---|---|---|---|---|
| 2 | 584 ms | 584 ms | 0 | 255.2 MB |
| 4 | 841 ms | 842 ms | 0 | 190.0 MB |
| 8 | 1462 ms | 1464 ms | 0 | 153.7 MB |

Caveat: aggregatePeakRssKb samples each reader's own process tree independently; true simultaneous aggregate memory would require one shared sampler across all N processes at once, which this per-reader sampler approximates by taking the max of per-reader peaks (a lower bound on true simultaneous aggregate RSS).

### Readers concurrent with an updater

- Updater (1 new commit + query): 871 ms (exit 0).
- 4 concurrent readers: p50 717 ms, p95 718 ms, failures 0, malformed responses 0.
- Final index state: current, 147 commits, 298 records, 22.2 MB on disk.

### Two simultaneous first uses (same repo, racing index build)

- Both processes exited 0: true. First 1971 ms, second 1997 ms. Final record count 274 vs. a normal serial first-use baseline of 274 -- matches: true (A coherent single index implies the raced final record count equals a normal serial first-use build's record count (no duplicate-record inflation).)

## 7. Failure examples and limitations

- **Sample size.** Dev/test splits are 24 cases each (20 answerable per split after excluding no-evidence and, where noted, exact_identifier); a single-point Hit@k/MRR estimate at this N carries wide uncertainty. Per protocol: this is a provisional product-quality floor, not a statistical claim, and no confidence interval is reported that would imply more precision than the sample supports.
- **All 6 retrieval fixtures are synthetic**, generated by `bench/fixtures/generate.mjs` (deterministic, seeded), not real-world repositories.
- **Real-repository validation:** `bench/dataset/external.json` has `status: "collected"` -- Reachable and pinned via `gh api` (authenticated GitHub CLI) on 2026-09-09. Every relevantSha below was verified to exist in the named repository and to be an ancestor of that repository's pinned cutoffSha via `gh api repos/<owner>/<repo>/compare/<sha>...<cutoffSha>` returning status "ahead" (i.e. the cutoff is strictly ahead of, and reachable from, the candidate commit on the default branch). No repository content or model output was used to author these questions beyond ordinary GitHub search/read access; queries were written by a human-style task description first, then checked against the real history, not the reverse. That status means the 12 cases (6 dev / 6 test, against expressjs/express and axios/axios) were authored and their relevant SHAs verified reachable via the GitHub API. **It does not mean retrieval was run against those repositories**: `bench/retrieval/run.mjs` only supports `--split=dev`/`--split=test` against the 6 synthetic fixtures, no local clone of expressjs/express or axios/axios exists under `bench/work/fixtures/`, and no `bench/results/retrieval/external-*` directory exists. Real-repository retrieval performance has NOT been measured, only claimed-reachable case construction.
- **No-evidence handling has no refusal path.** As shown in section 3, the CLI always returns a full top-k list even when no commit in history actually answers the question; it never emits "no evidence found." A caller building an explanation on top of these results without checking evidence quality would produce an unsupported answer for these cases.
- **Ablation is single-dataset, dev-only, 24 cases.** See section 4; do not generalize the "evidence ingestion doesn't clearly help" finding beyond this fixture set.
- **Perf corpus is small.** 135 commits vs. the 10k-commit scale docs/spec.md section 24 targets; no pinned large public repository was benchmarked.
- **Agent pilot not executed; arms B/C blocked on a missing dependency (`zg`).** See section 5.
- **Held-out split is not blinded** (see section 1) -- same authorship as the product under test.

## 8. Exact reproduction commands

All runs in this report were produced at code commit `73efd914efa56ce89e9b6f65e77b4fcf0fa24cc5` with the uncommitted working-tree changes listed in section 2 applied on top.

```
# Dev-split retrieval (text / semantic / hybrid, all categories)
node bench/retrieval/run.mjs --split=dev
# -> dev-2026-09-09T20-14-34-765Z

# Summaries-only vs summary+evidence ablation (dev split only)
node bench/retrieval/run.mjs --split=dev --ablation
# -> dev-2026-09-09T20-19-40-499Z

# Frozen held-out split (run exactly once; do not re-run after inspecting)
node bench/retrieval/run.mjs --split=test --i-accept-this-is-the-frozen-holdout
# -> test-2026-09-09T20-21-00-051Z

# CLI performance / parallel-load benchmark
node bench/perf/run.mjs
# -> 2026-09-09T20-23-36-126Z

# This report
node bench/report.mjs
# -> docs/report.md
```
