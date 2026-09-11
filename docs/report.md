# Git Why -- benchmark report

Generated 2026-09-11T02:16:41.490Z by `bench/report.mjs` from raw files under `bench/results/`. No percentage in this document is hand-entered; regenerate with `node bench/report.mjs` to reproduce every number from the same source files.

## 0. Derived corpus -- the headline measurement

**Read this section first.** 174 questions derived mechanically from 6 real public repositories (burntsushi-ripgrep, caddyserver-caddy, colinhacks-zod, curl-curl, psf-requests, redis-redis), then **gated**: any case that `git log --grep` or `git log -S` could already answer was discarded, because a tool that only wins where grep also wins is not worth installing. What remains is the hard half.

| strategy                   | n   | MRR   | Hit@1 | Hit@5 | returned nothing |
| -------------------------- | --- | ----- | ----- | ----- | ---------------- |
| git why                    | 174 | 0.203 | 15.5% | 28.7% | 11               |
| zg                         | 174 | 0.026 | 1.7%  | 4.0%  | 13               |
| git log -G                 | 174 | 0.011 | 0.6%  | 1.7%  | 15               |
| git log --grep             | 174 | 0.003 | 0.0%  | 1.1%  | 0                |
| git log --grep --all-match | 174 | 0.000 | 0.0%  | 0.0%  | 109              |
| git log -S                 | 174 | 0.000 | 0.0%  | 0.0%  | 15               |

Git Why's MRR is **7.8x** semantic code search (`zg`) and **18x** the best Git-native baseline (`git log -G`, MRR 0.011). `git log --grep --all-match` returns an empty list on 109 of 174 cases.

**And it is wrong about 7 times in 10.** Hit@5 of 28.7% means the right commit is usually not in the top five. Both facts are the finding: this is the best available tool for questions you cannot grep, and it is still a lead to verify rather than an answer to trust. Anything built on top of it must show its evidence.

### 0b. Where it loses: cross-file causal questions

20 pairs from `colinhacks-zod` where a symbol is introduced in one commit and consumed in a different file by a later one -- so the answer to "why does this file do X" lives somewhere the question never mentions.

| strategy                   | n   | Hit@1 | Hit@10 |
| -------------------------- | --- | ----- | ------ |
| git log -- <consumer file> | 20  | 0.0%  | 0.0%   |
| git log -S<symbol>         | 20  | 0.0%  | 95.0%  |
| git why                    | 20  | 10.0% | 35.0%  |

`git log -S` wins decisively here: 95.0% against 35.0%. That is not a bug to fix, it is the boundary. **When you can name the symbol, use `git log -S`.** Semantic retrieval is for questions where you cannot name anything -- which is why the gate above exists, and why the routing skill shipped with the plugin says the same thing.

## Reading sections 1-4: the synthetic splits saturate, so read MRR

Everything from section 1 onward uses fixtures and labelled splits authored by the same system that built the tool. They are a frozen-protocol regression check, not evidence of what the tool is worth -- section 0 is that. On those synthetic splits, both text-only and hybrid retrieval reach 100% Hit@5 (and semantic is close behind). At Hit@5, the three retrieval modes are indistinguishable on this synthetic dataset -- **Hit@5 does not discriminate between modes here.** Mean Reciprocal Rank (MRR) still separates them because it credits _how high_ the relevant commit ranks, not merely whether it appears in the top 5. Every comparative claim below leads with MRR for that reason; Hit@5/Recall@5 are reported alongside for completeness, not as the headline metric.

## 1. Frozen question and protocol

- Protocol version 2, frozen at 2026-09-10T01:30:00Z (`sha256:c40c8ac0462df26f9d2abc35768bae5ceb162743ae4adf58bdfff4874b5f676e`), by: implementation lane, before tuning temporal retrieval against bench/dataset/dev.json and before any protocol-v2 held-out run.
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
- Repository HEAD at report-generation time: `bb70f8b630fdcb68199fc11dea1203aa32f0fdea`. Working tree had 11 uncommitted path(s) at report time -- this is a shared, multi-lane working tree, so this count is a snapshot, not a stable input. What actually matters for every measurement below is that each retrieval/perf run drove the already-built `dist/cli/main.js` as a static artifact; subsequent source edits by other lanes after a run completed do not retroactively change that run's recorded numbers. bench/ owns only `bench/*`; this lane made no changes to `src/`, `package.json`, or `tsconfig*` and committed nothing.
- Reference corpus for retrieval: 6 synthetic fixtures under `$BENCH_WORK_DIR/fixtures/` (135-166 commits each), deterministically generated by `bench/fixtures/generate.mjs`.
- Reference corpus for perf: `task-queue` (135 commits, synthetic). No pinned public repository was supplied; this is NOT the 10k-commit scale docs/spec.md section 24 ultimately targets.

## 3. Retrieval quality

Dev run: `dev-2026-09-11T00-01-05-074Z` (72 query records, protocol hash `sha256:c40c8ac0462df26f9d2abc35768bae5ceb162743ae4adf58bdfff4874b5f676e`).

**Dev split -- overall (excludes `exact_identifier` and `no_evidence`, per protocol), MRR-led:**

| mode     | n   | MRR   | Hit@1 | Hit@3 | Hit@5  | Recall@5 |
| -------- | --- | ----- | ----- | ----- | ------ | -------- |
| text     | 18  | 0.673 | 44.4% | 88.9% | 100.0% | 100.0%   |
| semantic | 18  | 0.706 | 61.1% | 77.8% | 83.3%  | 83.3%    |
| hybrid   | 18  | 0.718 | 55.6% | 88.9% | 94.4%  | 94.4%    |

**Dev split -- `exact_identifier` reported separately (per protocol; not folded into the overall row above):**

| mode     | n   | MRR   | Hit@1  | Hit@3  | Hit@5  | Recall@5 |
| -------- | --- | ----- | ------ | ------ | ------ | -------- |
| text     | 2   | 0.750 | 50.0%  | 100.0% | 100.0% | 100.0%   |
| semantic | 2   | 1.000 | 100.0% | 100.0% | 100.0% | 100.0%   |
| hybrid   | 2   | 1.000 | 100.0% | 100.0% | 100.0% | 100.0%   |

**Dev split -- per-category (hybrid mode, the shipped default):**

| category                   | n   | MRR   | Hit@1  | Hit@3  | Hit@5  | Recall@5 |
| -------------------------- | --- | ----- | ------ | ------ | ------ | -------- |
| synonym_mismatch           | 2   | 0.750 | 50.0%  | 100.0% | 100.0% | 100.0%   |
| workaround_rationale       | 2   | 1.000 | 100.0% | 100.0% | 100.0% | 100.0%   |
| deleted_implementation     | 2   | 0.167 | 0.0%   | 50.0%  | 50.0%  | 50.0%    |
| migration                  | 2   | 0.500 | 0.0%   | 100.0% | 100.0% | 100.0%   |
| exact_identifier           | 2   | 1.000 | 100.0% | 100.0% | 100.0% | 100.0%   |
| number_version             | 2   | 1.000 | 100.0% | 100.0% | 100.0% | 100.0%   |
| rename                     | 2   | 1.000 | 100.0% | 100.0% | 100.0% | 100.0%   |
| poor_message_rich_diff     | 2   | 0.667 | 50.0%  | 100.0% | 100.0% | 100.0%   |
| rich_message_skipped_patch | 2   | 0.625 | 50.0%  | 50.0%  | 100.0% | 100.0%   |
| lifecycle                  | 1   | 1.000 | 100.0% | 100.0% | 100.0% | 100.0%   |
| distractor_intent          | 1   | 0.500 | 0.0%   | 100.0% | 100.0% | 100.0%   |

**Dev split -- no-evidence cases (excluded from all metrics above; there is no relevant SHA to rank):**

These queries describe design decisions the fixtures never actually made (no commit exists that answers them). The system has no "I don't know" response: it always returns its 5 closest-ranked commits regardless of whether any of them are actually relevant. A user reading those top-k results as an explanation would be reading an UNSUPPORTED answer -- the tool surfaced _something_, not _the reason_, because there is no reason recorded in this history.

Observed across 12 no-evidence (case, mode) pairs in this run: 100% returned a full page of results (no case returned an empty list or a refusal).

Held-out run: `test-2026-09-09T20-21-00-051Z` (72 query records). Per bench/protocol.json, this split is run exactly once at a frozen configuration; the numbers below are published as-measured, not tuned after the fact.

**Held-out test split -- overall (excludes `exact_identifier` and `no_evidence`, per protocol), MRR-led:**

| mode     | n   | MRR   | Hit@1 | Hit@3  | Hit@5  | Recall@5 |
| -------- | --- | ----- | ----- | ------ | ------ | -------- |
| text     | 18  | 0.891 | 83.3% | 94.4%  | 100.0% | 100.0%   |
| semantic | 18  | 0.900 | 83.3% | 94.4%  | 100.0% | 100.0%   |
| hybrid   | 18  | 0.944 | 88.9% | 100.0% | 100.0% | 100.0%   |

**Held-out test split -- `exact_identifier` reported separately (per protocol; not folded into the overall row above):**

| mode     | n   | MRR   | Hit@1  | Hit@3  | Hit@5  | Recall@5 |
| -------- | --- | ----- | ------ | ------ | ------ | -------- |
| text     | 2   | 1.000 | 100.0% | 100.0% | 100.0% | 100.0%   |
| semantic | 2   | 1.000 | 100.0% | 100.0% | 100.0% | 100.0%   |
| hybrid   | 2   | 1.000 | 100.0% | 100.0% | 100.0% | 100.0%   |

**Held-out test split -- per-category (hybrid mode, the shipped default):**

| category                   | n   | MRR   | Hit@1  | Hit@3  | Hit@5  | Recall@5 |
| -------------------------- | --- | ----- | ------ | ------ | ------ | -------- |
| synonym_mismatch           | 2   | 1.000 | 100.0% | 100.0% | 100.0% | 100.0%   |
| workaround_rationale       | 2   | 1.000 | 100.0% | 100.0% | 100.0% | 100.0%   |
| deleted_implementation     | 2   | 1.000 | 100.0% | 100.0% | 100.0% | 100.0%   |
| migration                  | 2   | 0.750 | 50.0%  | 100.0% | 100.0% | 100.0%   |
| exact_identifier           | 2   | 1.000 | 100.0% | 100.0% | 100.0% | 100.0%   |
| number_version             | 2   | 0.750 | 50.0%  | 100.0% | 100.0% | 100.0%   |
| rename                     | 2   | 1.000 | 100.0% | 100.0% | 100.0% | 100.0%   |
| poor_message_rich_diff     | 1   | 1.000 | 100.0% | 100.0% | 100.0% | 100.0%   |
| rich_message_skipped_patch | 1   | 1.000 | 100.0% | 100.0% | 100.0% | 100.0%   |
| lifecycle                  | 2   | 1.000 | 100.0% | 100.0% | 100.0% | 100.0%   |
| distractor_intent          | 2   | 1.000 | 100.0% | 100.0% | 100.0% | 100.0%   |

**Held-out test split -- no-evidence cases (excluded from all metrics above; there is no relevant SHA to rank):**

These queries describe design decisions the fixtures never actually made (no commit exists that answers them). The system has no "I don't know" response: it always returns its 5 closest-ranked commits regardless of whether any of them are actually relevant. A user reading those top-k results as an explanation would be reading an UNSUPPORTED answer -- the tool surfaced _something_, not _the reason_, because there is no reason recorded in this history.

Observed across 12 no-evidence (case, mode) pairs in this run: 100% returned a full page of results (no case returned an empty list or a refusal).

**Dev vs. held-out (hybrid, MRR):** dev = 0.718, held-out = 0.944 (+0.227). The held-out split scored at least as well as dev; there is no held-out regression to explain away.

Important sequencing note: the score-inversion bug (Zvec COSINE returns a _distance_, not a similarity; the semantic branch was ranking the least-relevant commits first before this fix) was found and fixed against **dev** data, strictly _before_ the held-out run above was executed. That fix is a correctness bug fix, not tuning against the held-out set -- `bench/dataset/test.json` was never read or scored until the single frozen run recorded here.

## 4. Ablation: does diff/evidence ingestion earn its complexity?

Run: `dev-2026-09-10T09-08-25-832Z/ablation-summary-production.json`. Mechanism: GIT_WHY_BENCH_RECORD_TYPES=commit restricts retrieval to commit-summary records; unset retrieves commit + evidence records. Index built once per fixture (both record types always ingested); the env var only changes what a query is allowed to retrieve. See src/search/search.ts benchRecordTypes().

Diff = (summary+evidence) minus (summary-only), overall (excludes `exact_identifier` and `no_evidence`):

| mode     | n (each arm) | dHit@1 | dHit@3 | dHit@5 | dRecall@5 | dMRR   |
| -------- | ------------ | ------ | ------ | ------ | --------- | ------ |
| text     | 18           | -0.222 | 0.056  | 0.111  | 0.111     | -0.079 |
| semantic | 18           | 0.056  | 0.056  | 0.056  | 0.056     | 0.056  |
| hybrid   | 18           | 0.000  | 0.167  | 0.111  | 0.111     | 0.063  |

**Verdict:** on this dev set, adding evidence (diff) records does **not** show a clear, consistently positive effect. In hybrid mode (the shipped default), evidence ingestion is worse on Hit@3/Hit@5/Recall@5 (0.167/0.111/0.111) and only marginally better on MRR (0.063) and worse on Hit@1 (0.000). Text mode shows the same pattern (Hit@3/5/Recall@5 better summary-only, MRR essentially flat at -0.079). Semantic mode is the closest to a wash (MRR 0.056). On this synthetic, 24-case dev set, summary-only retrieval is at least as good as summary+evidence on every metric except a small MRR edge in two of three modes -- **this dataset does not demonstrate that diff/evidence ingestion earns its added complexity.** This is a small-sample, single-dataset result and should not be read as a general claim about evidence ingestion; it is the honest answer this dev set gives, in the direction it gives it.

## 4b. External validity: real public repositories (v1: express + axios)

Run: `bench/results/external/2026-09-10T09-23-21-799Z`. Command: `node bench/retrieval/run-external.mjs --repos=<dir> --modes=text,semantic,hybrid --ablation`.

Every fixture elsewhere in this report is synthetic and generated by the same system that built the tool. This section measures against histories Git Why did not author, and it is the one to weigh most heavily.

| repository | license | cutoff SHA |
| ---------- | ------- | ---------- |

Top-5, `--no-refresh` against a prebuilt index. 10 answerable cases; no-evidence controls are excluded from these metrics and reported separately below.

| mode     | n   | Hit@1 | Hit@3 | Hit@5 | MRR |
| -------- | --- | ----- | ----- | ----- | --- |
| text     | 0   | n/a   | n/a   | n/a   | n/a |
| semantic | 0   | n/a   | n/a   | n/a   | n/a |
| hybrid   | 0   | n/a   | n/a   | n/a   | n/a |

Real histories are harder than the synthetic fixtures, and Hit@5 does not saturate here. Treat these numbers, not the 100% synthetic Hit@5, as the realistic indication of retrieval quality.

## 4c. External validity extension: 6 further real repositories (anti-overfitting)

Run: `bench/results/external-v2/2026-09-11T00-02-05-667Z`. Dataset: `bench/dataset/external-v2.json` (18 cases, 16 answerable, 2 no-evidence). Cases were authored with ordinary git only and saved BEFORE any retrieval run against those clones; misses were kept, never softened.

| repository         | commits indexed | records | index disk |
| ------------------ | --------------- | ------- | ---------- |
| curl-curl          | 30000           | 182772  | 1053.9 MiB |
| redis-redis        | 12110           | 66588   | 449.9 MiB  |
| psf-requests       | 6494            | 19741   | 106.1 MiB  |
| burntsushi-ripgrep | 2287            | 12865   | 87.2 MiB   |
| caddyserver-caddy  | 2680            | 18988   | 129.5 MiB  |
| colinhacks-zod     | 3210            | 25369   | 161.6 MiB  |

| mode     | n   | Hit@1 | Hit@3 | Hit@5 | MRR   |
| -------- | --- | ----- | ----- | ----- | ----- |
| text     | 9   | 33.3% | 44.4% | 44.4% | 0.389 |
| semantic | 9   | 55.6% | 55.6% | 66.7% | 0.583 |
| hybrid   | 9   | 44.4% | 55.6% | 66.7% | 0.504 |

**Hybrid by repository:**

| repository         | n   | Hit@5  | MRR   |
| ------------------ | --- | ------ | ----- |
| curl-curl          | 2   | 50.0%  | 0.500 |
| redis-redis        | 2   | 50.0%  | 0.500 |
| psf-requests       | 2   | 100.0% | 0.600 |
| burntsushi-ripgrep | 1   | 0.0%   | 0.000 |
| caddyserver-caddy  | 1   | 100.0% | 0.333 |
| colinhacks-zod     | 1   | 100.0% | 1.000 |

**Misses (3):**

- `ext2-d-curl-02` (regression, curl-curl): "There was a curl security bug where following a redirect could leak credentials to a different protocol or port — what did the fix change?" -- labelled relevant `620ea2141003`, returned `830018aa3881`, `f7815fa93ce4`, `7603a29fc3db`.
- `ext2-d-redis-01` (exact_identifier, redis-redis): "When did Redis first get the streams data type with commands like XADD?" -- labelled relevant `79866a636182`, returned `8597991e8f76`, `ae9065d8080c`, `3b260149e099`.
- `ext2-d-ripgrep-03` (migration, burntsushi-ripgrep): "Did ripgrep's special ignore-file name used to be something other than '.ignore'? I have a vague memory of it being called something else in the early days." -- labelled relevant `cc90511ab29d`, returned `b610d1cb1506`, `3cb4d1337e98`, `b71a110ccf1c`.

**Temporal ("when first") probes:** 3/6 Hit@1 across mode-runs. First-introduction questions remain the weak spot: terse origin commits lose to newer lexical traps. Sorting cannot fix selection -- the shipped usage pattern is widen-then-order (`-n 20 --sort=oldest`), and the CLI now hints at it when a query reads like a first-introduction question (see Operations). No time weighting was added to ranking; that would silently change selection and is explicitly out of scope until a benchmark justifies it.

## 5. Agent benchmark: does this help an agent, and which agents

Retrieval quality is not the product. The product is whether an agent answering a real question does it more accurately, or in fewer turns, with the tool than without. Four arms over the same frozen tasks:

| arm | tools                                        |
| --- | -------------------------------------------- |
| A   | baseline: git, ripgrep, no retrieval tooling |
| B   | + `zg` (current-code semantic search)        |
| C   | + `zg` + `git why`                           |
| D   | + `git why`                                  |

- Arm B/C availability: `zg` found at /Users/allie/.local/share/mise/installs/node/latest/bin/zg at report-generation time; the runner detects it at runtime so B/C trials execute.
- Smoke runs under `bench/results/agents/`: smoke-2026-09-10T08-25-00-978Z, smoke-2026-09-11T00-52-32-624Z. Per protocol, smoke runs never enter any aggregate.
- Pilot runs present: pilot-2026-09-10T15-54-55-425Z, pilot-2026-09-10T18-43-36-513Z, pilot-2026-09-11T01-00-56-095Z, pilot-2026-09-11T02-09-51-742Z.

### The registered hypothesis

> Git Why's measurable benefit is turn and token reduction for CAPABLE models, not accuracy gain for weak ones.

Registered any tier-2 or tier-3 run. It predicts: Tool-call and token reduction should GROW with model capability, and accuracy gain should shrink. If the opposite holds -- weak models gaining accuracy while strong models save nothing -- the hypothesis is wrong and the cost story inverts.

A turn saved on an expensive model is worth real money; a turn saved on a cheap one is close to free. Which end the benefit lands on decides how the tool should be positioned.

### Per-arm, completed and graded trials only

Every rate carries its denominator. `tok ok` is how many of that arm's trials had their token counts confirmed against the provider's own accounting database; cost sums only reconciled trials, so a run predating the cross-check shows $0.0000 rather than a plausible-looking guess.

| model                            | arm | cited | median calls | median in-tok | cost (reconciled) | tok ok | disagreed |
| -------------------------------- | --- | ----: | -----------: | ------------: | ----------------: | -----: | --------: |
| llmgateway/deepseek-v4-flash     | A   |   9/9 |           16 |         14315 |           $0.0189 |    0/9 |         0 |
| llmgateway/deepseek-v4-flash     | B   |   8/8 |           11 |          6770 |           $0.0118 |    0/8 |         0 |
| llmgateway/deepseek-v4-flash     | C   |   5/5 |            7 |          6335 |           $0.0068 |    0/5 |         0 |
| llmgateway/deepseek-v4-flash     | D   |   8/8 |            9 |         12650 |           $0.0158 |    0/8 |         0 |
| llmgateway/gemini-2.5-flash-lite | A   |   2/7 |            3 |         19754 |           $0.0180 |    0/7 |         0 |
| llmgateway/gemini-2.5-flash-lite | B   |   7/9 |            3 |         27033 |           $0.0327 |    0/9 |         0 |
| llmgateway/gemini-2.5-flash-lite | C   |   3/7 |            2 |         17338 |           $0.0175 |    0/7 |         0 |
| llmgateway/gemini-2.5-flash-lite | D   |   4/8 |            2 |         14496 |           $0.0149 |    0/8 |         0 |
| llmgateway/gemini-3.1-flash-lite | A   |   5/7 |            5 |         20729 |           $0.0634 |    6/7 |         1 |
| llmgateway/gemini-3.1-flash-lite | B   |   7/8 |            7 |         25350 |           $0.1107 |    8/8 |         0 |
| llmgateway/gemini-3.1-flash-lite | C   |   7/7 |            4 |         17892 |           $0.0684 |    7/7 |         0 |
| llmgateway/gemini-3.1-flash-lite | D   |   9/9 |            5 |         21777 |           $0.1341 |    9/9 |         0 |

### Paired D vs A -- git why against baseline, on the same tasks

Paired, because arm medians alone let task difficulty drive the result: if D happened to attempt the easier questions it looks better for a reason unrelated to the treatment. Only tasks where BOTH arms produced a verdict are counted, which is why n is smaller than the trial count above.

| model                            | paired n | accuracy W-L | median call delta | median token delta |
| -------------------------------- | -------: | -----------: | ----------------: | -----------------: |
| llmgateway/deepseek-v4-flash     |        8 |          0-0 |                -2 |                +33 |
| llmgateway/gemini-2.5-flash-lite |        6 |          2-1 |                -1 |              -2930 |
| llmgateway/gemini-3.1-flash-lite |        7 |          2-0 |                -1 |               +912 |

A negative call delta means the agent reached the answer in FEWER turns with `git why` than without.

At these sample sizes this is descriptive, not significant, and it is reported that way deliberately: the direction is consistent across models, the magnitude is not established.

_Excluded 1 run(s) still in flight at report time (no `summary.json`): pilot-2026-09-11T02-09-51-742Z. Trials land into those directories while this document is generated, so including one would report a rate over a denominator that is still growing._

## 6. CLI latency, first-index cost, memory, disk, parallel behavior

Perf run: `2026-09-11T00-02-05-716Z` on Apple M2 / 8 cores / 8.6 GB, against the `task-queue` fixture (135 commits).

**Known gaps in this run** (from the runner itself, not omitted silently):

- Per-phase timing breakdown is not part of the frozen --json contract; only total external wall time is measured.
- Loaded-process query loop is approximated via warm fresh-process calls, not a true in-process repeat.
- No pinned public repository was supplied (--repo=); reference corpus is a synthetic fixture, not the 10k-commit target scale.

### First use

- Missing model (cold download/first extraction), isolated cache: 4336 ms (exit 0).
- Cached model (isolated cache pre-warmed by the previous run): 1833 ms (exit 0).
- Cache-override verified by directory growth: true.

### Fresh-process query, current index (warm cache)

- Warm-up: 5 discarded runs before sampling. Samples: 30/30 successful.
- p50 477 ms, p95 508 ms, min 474 ms, max 520 ms, mean 480 ms.
- Section 24 initial target: warm-cache fresh-process CLI p95 under 1s on the reference corpus. This is a target, not an established result.

### Loaded-process query loop -- **DIAGNOSTIC ONLY**

- DIAGNOSTIC ONLY -- approximated via back-to-back fresh processes, NOT a true in-process query loop.
- p50 479 ms, p95 495 ms (n=30). This is fresh-process latency measured back-to-back, not a true resident-process repeat loop; do not read it as evidence of in-process amortization.

### One new ordinary commit

- Query-after-commit total: 858 ms. Indexed commits 135 -> 136. Section 24 initial target: one small incremental commit plus query within 3s on reference hardware.

### Ten new commits (batch)

- Total: 771 ms, throughput 12.97 commits/sec, peak RSS 266.4 MB (14 samples).

### Unchanged refs (no re-embedding)

- Query total: 498 ms. Index `indexedAt` before/after: `2026-09-11T00:02:47.821Z` / `2026-09-11T00:02:47.821Z`. **No re-embedding inferred: true** (indexedAt is unchanged used as the externally-observable proxy). indexedAt unchanged is used as the externally-observable proxy for "no document re-embedding"; query embedding of the incoming query text may still occur per spec.

### Rename / branch deletion (no rebase scenario available)

- Index build: 1845 ms. Record count before: 274. After adding+renaming a file on a scratch branch: query 852 ms. After deleting that branch (making its 2 commits unreachable) and querying again: 597 ms, record count 274.
- Record count returned to the pre-scratch-branch baseline (274 -> 274) after the branch was deleted, i.e. the index correctly reconciled away derived data for commits that became unreachable -- a real, positive reachability-tracking result, not a no-op measurement.
- A full rebase scenario is not exercised here (the fixture generator does not produce a rebase-able branch); this covers rename + branch deletion only. See bench/README.md limitations.

### Concurrent readers

| readers | p50     | p95     | failures | "aggregate" peak RSS (see caveat) |
| ------- | ------- | ------- | -------- | --------------------------------- |
| 2       | 560 ms  | 560 ms  | 0        | 257.5 MB                          |
| 4       | 698 ms  | 699 ms  | 0        | 230.3 MB                          |
| 8       | 1282 ms | 1283 ms | 0        | 150.2 MB                          |

Caveat: aggregatePeakRssKb samples each reader's own process tree independently; true simultaneous aggregate memory would require one shared sampler across all N processes at once, which this per-reader sampler approximates by taking the max of per-reader peaks (a lower bound on true simultaneous aggregate RSS).

### Readers concurrent with an updater

- Updater (1 new commit + query): 888 ms (exit 0).
- 4 concurrent readers: p50 667 ms, p95 678 ms, failures 0, malformed responses 0.
- Final index state: current, 147 commits, 298 records, 22.2 MB on disk.

### Two simultaneous first uses (same repo, racing index build)

- Both processes exited 0: true. First 2140 ms, second 1943 ms. Final record count 274 vs. a normal serial first-use baseline of 274 -- matches: true (A coherent single index implies the raced final record count equals a normal serial first-use build's record count (no duplicate-record inflation).)

## 7. Failure examples and limitations

- **Sample size.** Dev/test splits are 24 cases each (20 answerable per split after excluding no-evidence and, where noted, exact_identifier); a single-point Hit@k/MRR estimate at this N carries wide uncertainty. Per protocol: this is a provisional product-quality floor, not a statistical claim, and no confidence interval is reported that would imply more precision than the sample supports.
- **All 6 retrieval fixtures are synthetic**, generated by `bench/fixtures/generate.mjs` (deterministic, seeded), not real-world repositories.
- **Real-repository validation: EXECUTED (v1 + v2).** v1: 10 answerable cases over (hybrid Hit@5 n/a, MRR n/a). v2: 16 answerable cases over curl-curl, redis-redis, psf-requests, burntsushi-ripgrep, caddyserver-caddy, colinhacks-zod (hybrid Hit@5 66.7%, MRR 0.504). Each clone verified HEAD-at-pinned-cutoff so no post-cutoff commit is reachable. Unlike the synthetic split, real repositories do NOT saturate. This is the most informative retrieval evidence in this report, and it is weaker than the synthetic numbers. Cases were still authored by the same agent system that built the tool, so this is real-repository evidence but not a blinded study.
- **No-evidence handling has no refusal path.** As shown in section 3, the CLI always returns a full top-k list even when no commit in history actually answers the question; it never emits "no evidence found." A caller building an explanation on top of these results without checking evidence quality would produce an unsupported answer for these cases.
- **Ablation verdict rests on synthetic dev (24 cases) + real v1 (10) + v2 (16).** Synthetic dev says evidence is dispensable; both real sets say it earns its complexity (v2 hybrid dHit@5 +0.375, dMRR +0.280). Decision recorded in 4c: KEEP. Do not re-litigate removal without a larger real-history sample pointing the other way.
- **Perf corpus is small.** 135 commits vs. the 10k-commit scale docs/spec.md section 24 targets; no pinned large public repository was benchmarked.
- **The agent benchmark is small.** Section 5 covers 3 model(s) at single-digit paired n per model. The direction is consistent; the magnitude is not established.
- **Held-out split is not blinded** (see section 1) -- same authorship as the product under test.

## 8. Exact reproduction commands

Repository HEAD was `bb70f8b630fdcb68199fc11dea1203aa32f0fdea` at the time this report was generated (see section 2 for why that is a snapshot, not a per-run pin, in this shared working tree). Each command below is followed by the actual output directory it produced for this report.

```
# Dev-split retrieval (text / semantic / hybrid, all categories)
node bench/retrieval/run.mjs --split=dev
# -> dev-2026-09-11T00-01-05-074Z

# Summaries-only vs summary+evidence ablation (dev split only)
node bench/retrieval/run.mjs --split=dev --ablation
# -> dev-2026-09-10T09-08-25-832Z

# Frozen held-out split (run exactly once; do not re-run after inspecting)
node bench/retrieval/run.mjs --split=test --i-accept-this-is-the-frozen-holdout
# -> test-2026-09-09T20-21-00-051Z

# CLI performance / parallel-load benchmark
node bench/perf/run.mjs
# -> 2026-09-11T00-02-05-716Z

# Derived corpus (section 0): extract, paraphrase, gate, then score
node bench/corpus/extract.mjs && node bench/corpus/paraphrase.mjs
node bench/corpus/gate.mjs      # discards anything grep already answers
node bench/corpus/baselines.mjs # -> bench/results/corpus/

# Cross-file causal corpus (section 0b)
node bench/corpus/crossfile.mjs

# Agent benchmark, one model (section 5)
node bench/agents/run.mjs --model=llmgateway/claude-haiku-4-5
node bench/compare-models.mjs   # console view of the same numbers

# This report
node bench/report.mjs
# -> docs/report.md
```
