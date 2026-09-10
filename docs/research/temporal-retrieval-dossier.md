# Temporal retrieval dossier

Research notes for time-based queries in Git Why. Compiled 2026-09-09 from the
2024-2026 temporal information-retrieval literature plus a review of what the
current CLI and `zg` 0.2.2 actually do. This is a design input, not a spec.
The spec lives in `docs/spec.md`; when the two disagree, the spec wins and
this file should be updated.

## 1. The problem

Questions about history are frequently temporal:

- "When was HTTP/3 support first introduced?"
- "When and why was the Safari cookie workaround removed?"
- "What did the retry logic look like before the migration to the new client?"
- "Show me the history of how session refresh evolved."

Git Why today has three temporal pieces: `--after`/`--before` date filters,
`--sort=oldest|newest`, and a warning string that fires when a query looks
like a first-introduction question. All three push the work to the user, and
none fixes the failure observed on real repositories: the originating commit
is often terse ("add vquic", "initial streams") and never enters the candidate
pool, so no re-sorting or re-weighting can surface it. On the external-v2 set
"when first" probes scored 4 of 15 at Hit@1 (see `docs/report.md` section 4c).

The "retrieve wide, then filter or sort by date" pattern is rejected for two
reasons: sorting discards the semantic signal, and filtering assumes the user
knows a date, which is exactly what they do not remember.

## 2. What the literature says

All of the papers below evaluate on news or Wikipedia question answering.
None evaluates on version-control history. The principles transfer; the
numbers do not.

### 2.1 Decompose the query, then multiply a constraint-shaped temporal score into semantic score

MRAG (Siyue et al., EMNLP 2025 Findings) is the cleanest trainless result.
Each question is split into a temporally neutral main content and a temporal
constraint. Retrieval runs on the main content. Each candidate is scored as
`semantic * temporal`, where `temporal` is in [0, 1] and is a spline chosen
by constraint type: first-before, first-after, first-between, last-before,
last-after, last-between. A "last before 1981" constraint gives a document
dated 1970 roughly 0.9. When a passage has several dates the best one is
used. Results on TempRAGEval-TimeQA, top-5 evidence recall:

| system                      | recall@5 |
| --------------------------- | -------- |
| BM25                        | 39.0%    |
| Contriever                  | 49.9%    |
| Contriever + Gemma reranker | 66.6%    |
| MRAG                        | 73.5%    |

Limitations stated by the authors: explicit constraints only, roughly double
the cost of plain RAG because of an LLM summarization step, and ambiguity in
multi-part constraints.

Takeaway for Git Why: keep the fused RRF score in the final product so
semantic relevance is never thrown away, and shape the temporal term by
intent type rather than by a single decay curve.

### 2.2 Never apply a fixed recency prior; make the balance query-adaptive

Re3 (2025) frames temporal IR as two axes, relevance (does the document's
content time match the query's time) and recency (freshest version among
duplicates), and shows that fixed fusion collapses when both axes matter.
Final score is `sigmoid(alpha) * semantic + (1 - sigmoid(alpha)) * temporal`
with a learned per-query gate. Ablation on their hybrid benchmark: recall@1
drops from 0.742 to 0.268 with a fixed equal weight. Time gaps are encoded
with multi-frequency Fourier features, and missing timestamps get a learned
embedding (disabling that drops recency recall@1 from 0.649 to 0.405).

"Freshness and the Limits of Heuristic Trend Detection in Temporal RAG"
(2025) finds a half-life decay prior can surface newer documents but is
brittle and parameter-sensitive, and recommends learned-to-rank temporal
models instead of fixed decay.

Takeaway: when no temporal intent is detected the temporal term must be
identity. When intent is detected, weight it by how explicit the intent is.
Never ship an always-on recency boost.

### 2.3 Represent evolving knowledge as validity intervals on a graph

VersionRAG (2025) models a document's versions as a graph and answers "when
did X change" by locating the version where a fact first appears or changes.
TG-RAG (2025) keeps a temporal knowledge graph with timestamped edges plus a
hierarchical time graph, retrieves a subgraph within the semantic and temporal
scope of the query, and supports incremental updates by only regenerating
new leaf time nodes. IA-RAG (2026) applies Allen interval algebra: facts
carry validity intervals and queries are constrained by the 13 interval
relations. Zep's Graphiti (2025) uses a bi-temporal model with `valid_at` and
`invalid_at` on every edge; superseded facts are invalidated, not deleted,
and hybrid retrieval combines embeddings, BM25 and graph traversal.

Takeaway: Git history already is this structure. Every hunk, path and
identifier has an interval from the commit that added it to the commit that
removed it. Ordinal questions (first, last, removed) should be answered from
interval endpoints resolved on the commit DAG, with vectors used to find the
entry point. This is the lineage table in section 4.

### 2.4 For "history of X" questions, retrieve for coverage, not top-k

TA-RAG (2025) handles analytical diachronic questions by splitting the query
into a temporally neutral core and a period, sampling anchor points across
the period, building a query embedding per anchor, and retrieving so that
every sub-period is represented. On their ADQAB benchmark: 71.73% accuracy
with 5 documents versus 44.27% for naive RAG, peaking at 88.23% with 20.
Overhead is about 40% latency from extra LLM calls.

Takeaway: timeline mode should return the lineage chain with one evidence
hunk per episode (introduced, modified, removed), not the five most similar
commits.

### 2.5 Embedding-level time fusion: promising, but needs training data

TempRetriever (WSDM 2026) fuses a learned timestamp embedding with the text
embedding. Feature stacking (concatenation) was the best of four fusion
strategies: 69.72% top-1 on ArchivalQA and 50.22% on ChroniclingAmericaQA,
about 9.6 points over plain DPR, with same-year hard negatives helping. But
implicit query-date prediction reaches only 20% accuracy (mean error 3.5
years), the method needs timestamp-labelled training pairs, and the paper
does not measure whether non-temporal queries degrade.

"Efficient Temporal-aware Matryoshka Adaptation" (2026) addresses the
catastrophic forgetting that full fine-tuning for time causes, by adapting
only the embedding dimensions that carry temporal signal.

TsContriever (2024), TempRALM (2024, temporal score added to Atlas
retrieval, up to 165% relative recall@1 gain on TPQ-2020), and TimeRAG
(CIKM 2025, query decomposition into atomic time-event sub-questions,
66.4% average accuracy) are the other reference points.

Takeaway: not the foundation. A later phase can fine-tune the static
embedder using supervision Git provides for free: commit-message and diff
pairs with timestamps, and same-file-different-era hard negatives.

### 2.6 Survey position

"It's High Time: A Survey of Temporal Question Answering" (2025) classifies
questions as explicit versus implicit, ordinal (first, last), relative
(before, after, during) and interval-based, and states that ordinal and
implicit questions remain the hardest and that no single retrieval technique
dominates. It recommends benchmarks that mix temporal and non-temporal
complexity so that temporal handling can be shown not to regress ordinary
queries.

## 3. What `zg` 0.2.2 has and does not have

Checked against the installed binary (`zg query --help`) and the docs.

| capability                  | zg                                             | git why today                        |
| --------------------------- | ---------------------------------------------- | ------------------------------------ |
| hybrid lexical + vector     | yes, default route                             | yes, RRF at commit level             |
| multiple query groups       | `--hybrid/--fts/--vector` repeatable, `--fuse` | no                                   |
| symbol bias                 | `--prefer-symbol`, `--symbol-type`             | `--text` only                        |
| time handling               | `--modified-after/--modified-before` on mtime  | `--after/--before` on committer time |
| commit or lineage awareness | none                                           | commit collapse, evidence hunks      |
| refresh policy              | `--refresh background\|wait\|off`              | `--no-refresh`                       |
| readiness check             | `zg status --check-ready`                      | none                                 |
| MCP                         | one tool with a `fuse` parameter               | server exists, no temporal schema    |

zg's time handling is a plain filter and is not a model for Git Why. The
features worth borrowing are query groups with `--fuse` (the primitive
TA-RAG anchor sampling needs), a readiness check for the benchmark harness,
and an explicit refresh policy flag.

## 4. Design for Git Why

Principles, each traceable to section 2:

1. Vectors locate the topic; the commit DAG resolves time. Timestamps are
   never embedded.
2. No filter-then-sort. No recency prior when no temporal intent is present.
3. Semantic relevance stays in the final score:
   `final = fusedRRF(c) * temporal(c) ^ w`, `temporal` in [0, 1].
4. Ordinal answers come from validity intervals resolved by ancestry
   (generation numbers or merge-base), never from timestamps, because
   rebases and cherry-picks lie.
5. The candidate pool grows by structure (lineage expansion from semantic
   seeds), not by a wider top-k.

Components:

- **Intent decomposition.** Core query plus a constraint of type none,
  first, last, removed, changed_when, before, after, between, around, or
  timeline, with an optional anchor (date, tag, SHA, or another query) and a
  confidence of explicit or inferred. Rules cover explicit phrasing; agents
  and the MCP tool pass the constraint as a structured field. Anchors that
  are queries are resolved by a nested hybrid search.
- **Lineage table at index time.** For each identifier-like token and each
  path key: earliest and latest adding commit, earliest and latest removing
  commit, plus hunk overlap links between commits. This is `git log -S`
  precomputed once, keyed by things a semantic hit can supply. Stored under
  the generation directory, refreshed incrementally, size reported by
  `git why status`.
- **Structural expansion.** From the top semantic seeds, add commits linked
  by lineage. Linked commits inherit the seed's fused score discounted by
  hop count and are tagged in `matchedBy`. Disabled when the constraint is
  none.
- **Constraint-shaped scoring.** Per-type functions mirroring MRAG's splines
  but over DAG position: first scores earliest-in-ancestry highest, last
  mirrors, before and after score by proximity to the anchor on the correct
  side, around is a Gaussian in log time, none is identity. Exponent `w` is
  1.0 for explicit intent and 0.5 for inferred. Constants are tuned on the
  dev split only.
- **Ordinal resolution and timeline.** For first, last and removed, return a
  separate `answer` from the interval table alongside the ranked list.
  Timeline mode returns the chain in ancestry order with one evidence hunk
  per episode.
- **Query groups.** `--group` repeatable with `--fuse`, fused by RRF at the
  commit level. Used by timeline mode to sample anchors across a period and
  by agents that decompose questions themselves.
- **Envelope.** `temporal {intent, anchor, w}`, per-result
  `scores {fused, temporal, final}`, `answer`, `timeline`. Schema version
  bump.

Later phase, only after the trainless version is measured: temporal hard
negatives from Git (same file, different era) for embedder fine-tuning, and a
Re3-style gate trained on synthetic constrained queries generated from
commit messages.

## 5. Evaluation

- Add a temporal stratum to the dataset (dev, test and external-v2 clones)
  labelled with `introducedSha`, `removedSha` and an ordered chain.
- Metrics: exact-first, exact-removal, timeline precision and recall.
- Report non-temporal MRR before and after to prove the temporal term does
  not regress ordinary queries (the Re3 and survey warning).
- Tune spline constants on dev only; bump the protocol version and hash
  before touching the held-out split.
- Baseline to beat: 4 of 15 Hit@1 on "when first" probes in external-v2.

## 6. Open questions

- How large does the lineage table get on curl-sized histories, and what
  token filter keeps it bounded without losing origin commits?
- Should "removed" prefer the commit that deleted the last occurrence or the
  first deletion of any occurrence? Likely the last, but verify on real
  cases.
- Merge commits: use first-parent lineage for ordinal answers, or the merge
  itself? Real repositories with squash-merge versus merge-commit workflows
  will differ.
- Whether inferred intent should ever change ranking, or only add the
  `answer` field and a hint. Measure both on dev.

## 7. Sources

- MRAG: A Modular Retrieval Framework for Time-Sensitive Question Answering.
  https://aclanthology.org/2025.findings-emnlp.167/
- Re3: Learning to Balance Relevance and Recency for Temporal Information
  Retrieval. https://arxiv.org/abs/2509.01306
- TempRetriever: Fusion-based Temporal Dense Passage Retrieval for
  Time-Sensitive Questions. https://arxiv.org/abs/2502.21024
- Efficient Temporal-aware Matryoshka Adaptation for Temporal Information
  Retrieval. https://arxiv.org/abs/2601.05549
- It's About Time: Incorporating Temporality in Retrieval Augmented Language
  Models (TempRALM). https://arxiv.org/abs/2401.13222
- Reading Between the Timelines: RAG for Answering Diachronic Questions
  (TA-RAG). https://arxiv.org/abs/2507.22917
- Freshness and the Limits of Heuristic Trend Detection in Temporal RAG.
  https://arxiv.org/abs/2509.19376
- IA-RAG: Interval-Algebra-Driven Temporal Reasoning for Dynamic Knowledge
  Retrieval. https://arxiv.org/abs/2606.06044
- VersionRAG: Version-Aware Retrieval-Augmented Generation for Evolving
  Documents. https://arxiv.org/abs/2510.08109
- RAG Meets Temporal Graphs: Time-Sensitive Modeling and Retrieval for
  Evolving Knowledge (TG-RAG). https://arxiv.org/abs/2510.13590
- Zep: A Temporal Knowledge Graph Architecture for Agent Memory (Graphiti).
  https://arxiv.org/abs/2501.13956
- It's High Time: A Survey of Temporal Question Answering.
  https://arxiv.org/abs/2505.20243
- TimeRAG: Enhancing Complex Temporal Reasoning with Search Engine
  Augmentation. https://dl.acm.org/doi/10.1145/3746252.3761425
- Zvec-Grep CLI reference. https://zvec.org/en/docs/zvec-grep/cli/
