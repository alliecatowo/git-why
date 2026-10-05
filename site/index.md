---
layout: dig
title: Git Why
titleTemplate: Semantic archaeology for Git
---

Every number below is written into this page by `bench/report.mjs` from raw run
data, and CI fails if it drifts. Full methodology, dataset provenance and the
negative results are in the [benchmark report](/guide/benchmarks).

<!-- generated:corpus-table -->

174 **recall** questions — you remember a problem but cannot name anything in the
commit that fixed it — derived mechanically from 6 pinned real repositories
(curl, redis, requests, ripgrep, caddy, zod). Every question is verified **unanswerable by
keyword search** before it enters the set: if `git log --grep` or `git log -S` finds the
answer from the question's own words, the case is discarded.

| strategy                   | Hit@1     | Hit@5     | MRR       | returned nothing |
| -------------------------- | --------- | --------- | --------- | ---------------- |
| **git why**                | **0.201** | **0.374** | **0.266** | 0                |
| zg (semantic code search)  | 0.017     | 0.040     | 0.026     | 2                |
| git log -G                 | 0.006     | 0.017     | 0.011     | 15               |
| git log --grep             | 0.000     | 0.011     | 0.003     | 0                |
| git log --grep --all-match | 0.000     | 0.000     | 0.000     | **109**          |
| git log -S                 | 0.000     | 0.000     | 0.000     | 15               |

**10.2x `zg` and 23x the best Git-native strategy** — and the only approach that answers nearly every question rather than returning an empty set.

<!-- /generated:corpus-table -->

<!-- generated:crossfile -->

When you can name the symbol, use pickaxe search instead. On cross-file causal
questions, `git log -S` scores Hit@10 **0.950** against `git why`'s 0.350.
Semantic search has no advantage over a tool you can hand the exact literal.

<!-- /generated:crossfile -->

That boundary is in the
[skill shipped with the plugin](/guide/examples#when-not-to-use-this), because
a tool that oversells itself makes an agent worse at its job.

### Does it help an agent?

<!-- generated:agent -->

Retrieval quality is not the product. The question is whether an agent answering a real
question does it more accurately, or in fewer turns, with the tool than without. Four arms
over the same frozen tasks, paired per task, with token counts reconciled against the
provider's own accounting database.

| model                 | paired n | accuracy W-L | median tool calls saved |
| --------------------- | -------: | -----------: | ----------------------: |
| gemini-3.1-flash-lite |        6 |          1-2 |                     2.5 |
| claude-haiku-4-5      |        9 |          1-1 |                       1 |
| claude-sonnet-5       |        8 |          0-0 |                       1 |
| deepseek-v4-flash     |        8 |          0-0 |                     3.5 |
| gemini-2.5-flash-lite |        6 |          2-1 |                       1 |
| gemini-3.1-flash-lite |        7 |          2-0 |                       1 |
| gemini-3.5-flash      |        6 |          0-0 |                0.5 more |

Results are mixed across models. At single-digit paired n per model this is descriptive, not significant, and it is reported that way
deliberately — the direction is consistent, the magnitude is not established. Full method and per-arm figures in the benchmark report.

<!-- /generated:agent -->

Method, per-arm figures and the registered hypothesis are in the
[benchmark report](/guide/benchmarks).

<!-- generated:scale -->

| measurement                                                  | result                        |
| ------------------------------------------------------------ | ----------------------------- |
| Index across 6 real repos (56,781 commits)                   | 5.51–7.84 KB/record           |
| curl-curl (30,000 commits, 182,772 records)                  | 1.37 GiB, 7.84 KB/record      |
| Query on curl-curl (30,000 commits) with `git why server on` | 384 ms p50, 491 ms p95        |
| The same query with no daemon                                | 851 ms p50, 1371 ms p95       |
| Diff/evidence ingestion, real-repo ablation                  | earns its cost, ΔHit@5 +0.375 |

<!-- /generated:scale -->

<!-- generated:honesty -->

**It is also wrong most of the time.** Hit@5 of 0.374 means the right commit is
outside the top five on 62.6% of these questions. It beats every alternative on
them and still fails on most. Treat a result as a lead to verify with `git show`, never as
established fact.

<!-- /generated:honesty -->

### When to use ordinary Git instead

Git Why is ranked retrieval over a semantic index. That's the wrong tool for
some jobs, and Git already has the right one:

- **A known exact string** — `git log -S` / `git log -G` are exhaustive; a
  ranked keyword search is not.
- **An exhaustive search** — `ripgrep` over a checkout, or `git grep`.
- **Verifying causality** — similarity is not a timeline. Confirm ancestry
  with `git merge-base`, `git log --ancestry-path`, `git show`.

Read the full case in [How it works](/guide/how-it-works#when-not-to-use-this).
