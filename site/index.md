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

## See it find something you didn't search for

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
