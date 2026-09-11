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

<Cast src="/casts/owners.cast" title='git why "TLS backend abstraction and vtls layer" --owners' />

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

Full methodology, dataset provenance, and the real-repository numbers are in
the [benchmark report](/guide/benchmarks). The headline: real-repository
retrieval (not the saturated synthetic fixtures) is the number worth weighing.
Commit counts and index sizes below are the recorded scale of the external
benchmark runs (`bench/results/external/`); latency is fresh-process warm-cache
CLI time on the `task-queue` reference fixture (135 commits).

| Measurement                                                         | Result                          |
| ------------------------------------------------------------------- | ------------------------------- |
| Index `expressjs/express`                                           | 6167 commits, 126 MiB index     |
| Index `axios/axios`                                                 | 2185 commits, 80.8 MiB index    |
| Warm query, fresh process (p50 / p95)                               | 496 ms / 509 ms                 |
| Real-repository retrieval (10 hand-authored cases, express + axios) | Hit@5 90%, Hit@1 60%, MRR 0.733 |

## When to use ordinary Git instead

Git Why is ranked retrieval over a semantic index. That's the wrong tool for
some jobs, and Git already has the right one:

- **A known exact string** — `git log -S` / `git log -G` are exhaustive; a
  ranked keyword search is not.
- **An exhaustive search** — `ripgrep` over a checkout, or `git grep`.
- **Verifying causality** — similarity is not a timeline. Confirm ancestry
  with `git merge-base`, `git log --ancestry-path`, `git show`.

Read the full case in [How it works](/guide/how-it-works#when-not-to-use-this).
