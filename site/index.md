---
layout: home

hero:
  name: 'Git Why'
  text: 'Finds the history that explains the code.'
  tagline: "`git blame` tells you who changed it. `git why` finds the commit, the author's real words, and the diff that explain why."
  image:
    src: /logo.svg
    alt: Git Why
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: How it works
      link: /guide/how-it-works
    - theme: alt
      text: View on GitHub
      link: https://github.com/alliecatowo/git-why

features:
  - title: Hybrid retrieval, fused at the commit
    details: Full-text and vector search run independently over your commit history and are combined with Reciprocal Rank Fusion, so exact identifiers and paraphrased questions both work.
  - title: Retrieves evidence, never invents it
    details: Every result is a real commit, its author's actual words, and the relevant diff. Git Why does not generate an explanation of its own.
  - title: Local by default
    details: Embedding runs in-process with a small static model. Repository text is never sent to a model host; after one checksummed download, it works fully offline.
---

## See it run

<Cast src="/casts/ask.cast" title='git why "why did making lots of schemas suddenly get slow and memory-hungry"' />

No identifier to grep for, no file to scope to — the question shares almost no
vocabulary with the commit that answers it. That mismatch is the whole reason
this exists.

<Cast src="/casts/owners.cast" title='git why "TLS backend abstraction and vtls layer" --owners -n 20' />

`git blame` credits whoever last touched a line; `git shortlog` credits churn.
This weights commits by relevance instead.

## An agent using it

<Cast src="/casts/agent.cast" title="An agent asked why schema creation got slow" />

The agent was given a neutral list of what exists — `git log`, `git show`,
`git blame`, `grep`, `rg`, `git why` — and **no instruction about which to
use**. Network tools were shadowed, so the GitHub API was not an escape hatch.

It chose history search on its own, found the commit, verified it, and reported
the measured numbers including the one axis that regressed.

Two earlier takes of this same recording are worth knowing about. In the first,
`gh` was on PATH and the agent answered from the GitHub API without touching
the repository at all. In the second the prompt told it which tool to use for
what, which proves nothing: of course it complies. Only the third — neutral
list, no network — actually tests whether a model reaches for history unaided.

## Honest numbers

On 174 questions derived from six real repositories, each verified
**unanswerable by keyword search** before entering the set:

| strategy         | Hit@5     | MRR       |
| ---------------- | --------- | --------- |
| **git why**      | **0.287** | **0.203** |
| zg               | 0.040     | 0.026     |
| `git log --grep` | 0.011     | 0.003     |
| `git log -S`     | 0.000     | 0.000     |

**18x the best Git-native strategy** — and wrong roughly seven times in ten.
Both halves are true and both are on the [benchmarks page](/guide/benchmarks).

When you _can_ name the symbol, `git log -S` beats this 0.950 to 0.350. The
shipped agent skill says so, because a tool that oversells itself makes an
agent worse at its job.

## Why a semantic index, not a grep

The query below shares no vocabulary with the commit it finds. That is the
actual point of a semantic index: it carries the meaning of the change, not
just its words. Output is real, from `mise run demo`, which rebuilds
`bench/fixtures/demo/build.mjs` and runs these queries against it.

```text
$ git why "that bizarre bug where reconnecting subscribed twice"

1. 7deab42  Stop duplicate subscriptions after reconnect
   2025-11-20 · Maya Chen

   Reconnecting re-ran the subscribe handler without clearing the previous
   registration, so every reconnect doubled the delivered events.

   src/net/socket.ts
   -export function connect(url) { return new Socket(url); }
   +export function connect(url) {
   +  const s = new Socket(url);
   +  s.on('reconnect', () => resubscribeOnce(s));
   +  return s;
   +}
```

```text
$ git why "why do we keep the session when the refresh token is empty?"

1. f17db20  Fix infinite token-refresh loop
   2025-11-03 · Maya Chen

   Provider X can return an empty refresh token while the current access
   token remains valid. Retrying here puts clients into an infinite loop.

   src/auth/refresh.ts
    export function refresh(session, refreshToken) {
   -  if (!refreshToken) throw new InvalidTokenError();
   +  if (!refreshToken) return session;
      return exchange(refreshToken);
    }
```

## Install

```sh
curl -fsSL https://alliecatowo.github.io/git-why/install.sh | sh
```

```sh
npm install -g @alliecatowo/git-why
```

The package installs a `git-why` executable, which Git dispatches as the
subcommand `git why`. See [Getting started](/guide/getting-started) for the
first query and first index.

## Measured, not claimed

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
| **git why**                | **0.155** | **0.287** | **0.203** | 11               |
| zg (semantic code search)  | 0.017     | 0.040     | 0.026     | 13               |
| git log -G                 | 0.006     | 0.017     | 0.011     | 15               |
| git log --grep             | 0.000     | 0.011     | 0.003     | 0                |
| git log --grep --all-match | 0.000     | 0.000     | 0.000     | **109**          |
| git log -S                 | 0.000     | 0.000     | 0.000     | 15               |

**7.8x `zg` and 18x the best Git-native strategy** — and the only approach that answers nearly every question rather than returning an empty set.

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
| claude-haiku-4-5      |        9 |          1-1 |                       1 |
| deepseek-v4-flash     |        8 |          0-0 |                       3 |
| gemini-2.5-flash-lite |        6 |          2-1 |                       1 |
| gemini-3.1-flash-lite |        7 |          2-0 |                       1 |

Every model reached the answer in the same number of turns or fewer. At single-digit paired n per model this is descriptive, not significant, and it is reported that way
deliberately — the direction is consistent, the magnitude is not established. Full method and per-arm figures in the benchmark report.

<!-- /generated:agent -->

Method, per-arm figures and the registered hypothesis are in the
[benchmark report](/guide/benchmarks).

<!-- generated:scale -->

| measurement                                               | result                        |
| --------------------------------------------------------- | ----------------------------- |
| Index across 6 real repos (56,781 commits)                | 5.50–6.98 KB/record           |
| curl (30,000 commits)                                     | 1.00 GiB, 5.74 KB/record      |
| Warm query on curl-curl (30,000 commits), p50 / p95, n=20 | 3776 ms / 4368 ms             |
| The same query on a 135-commit fixture                    | 477 ms / 508 ms               |
| Diff/evidence ingestion, real-repo ablation               | earns its cost, ΔHit@5 +0.375 |

<!-- /generated:scale -->

<!-- generated:honesty -->

**It is also wrong most of the time.** Hit@5 of 0.287 means it misses roughly
seven hard questions in ten. It beats every alternative on those questions and
still fails on most of them. Treat results as leads to verify with `git show`,
never as established fact.

<!-- /generated:honesty -->

## When to use ordinary Git instead

Git Why is ranked retrieval over a semantic index. That's the wrong tool for
some jobs, and Git already has the right one:

- **A known exact string** — `git log -S` / `git log -G` are exhaustive; a
  ranked keyword search is not.
- **An exhaustive search** — `ripgrep` over a checkout, or `git grep`.
- **Verifying causality** — similarity is not a timeline. Confirm ancestry
  with `git merge-base`, `git log --ancestry-path`, `git show`.

Read the full case in [How it works](/guide/how-it-works#when-not-to-use-this).
