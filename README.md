# Git Why

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node.js >= 22.12](https://img.shields.io/badge/node-%3E%3D22.12-blue.svg)](https://nodejs.org/)
[![CI](https://github.com/alliecatowo/git-why/actions/workflows/ci.yml/badge.svg)](https://github.com/alliecatowo/git-why/actions/workflows/ci.yml)

**`git blame` tells you who changed the code. `git why` finds the history
that explains it.**

Local-first semantic + full-text search over Git history. It returns the
actual commit, its author's real words, and the relevant diff. It retrieves
evidence; it does not generate an explanation of its own.

Real output from `mise run demo`, which rebuilds the fixture repository from
`bench/fixtures/demo/build.mjs` and runs these queries. Nothing here is
hand-written.

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
subcommand `git why`. No alias setup needed. More install paths — pinned
versions, a GitHub release tarball, building from source, uninstalling —
are in [`docs/install.md`](docs/install.md).

## Use it with Claude Code

```sh
npm install -g @alliecatowo/git-why
```

Two plugins ship in `plugins/`: `git-why` on its own, and `git-why-full`
which pairs it with [`zg`](https://zvec.org) and adds an explorer agent.
OpenCode users get `opencode/` instead. It registers the MCP
server and ships a skill that teaches an agent **when to reach for history and
when not to** — including the case where `git log -S` is the better tool, since
a skill that oversells its own tool makes an agent worse at its job.

See [`docs/plugin.md`](docs/plugin.md).

## Why

`git log --grep` only matches words you already know. The reason code
changed usually lives in a commit message, but you rarely remember its exact
wording — you remember the _problem_, in your own words, months later.

Look again at the first example above: the query is "reconnecting subscribed
twice" and the commit is titled "Stop duplicate subscriptions after
reconnect." They share almost no vocabulary. That's not a coincidence Git
Why is showing off — it's the actual point of a semantic index. It carries
the meaning of the change, not just its words, alongside an ordinary keyword
index for when you _do_ know the exact term.

Git Why retrieves historical evidence: the commit, the author's actual
words, and the relevant diff. Historical commit messages are assertions by
their authors, not infallible accounts of intent, and some reasons were
never committed at all — Git Why will not manufacture those.

## Measured, not claimed

Every number is generated from raw run data by `bench/report.mjs`, never typed
by hand. Full methodology, limits, and the negative results in
[`docs/report.md`](docs/report.md).

### Against the tools you would otherwise use

174 questions derived mechanically from six pinned real repositories (curl,
redis, requests, ripgrep, caddy, zod). Every question is verified **unanswerable
by keyword search** before it enters the set — if `git log --grep` or
`git log -S` finds the answer from the question's own words, the case is
discarded. What remains is the regime this tool exists for.

| strategy                   | Hit@1     | Hit@5     | MRR       | returned nothing |
| -------------------------- | --------- | --------- | --------- | ---------------- |
| **git why**                | **0.155** | **0.287** | **0.203** | 11               |
| zg (semantic code search)  | 0.017     | 0.040     | 0.026     | 13               |
| git log -G                 | 0.006     | 0.017     | 0.011     | 15               |
| git log --grep             | 0.000     | 0.011     | 0.003     | 0                |
| git log --grep --all-match | 0.000     | 0.000     | 0.000     | **109**          |
| git log -S                 | 0.000     | 0.000     | 0.000     | 15               |

**7.8x `zg` and 18x the best Git-native strategy** — and the only approach that
answers nearly every question rather than returning an empty set.

### Where it loses

When you can name the symbol, use pickaxe search instead. On cross-file causal
questions, `git log -S` scores Hit@10 **0.950** against `git why`'s 0.350.
Semantic search has no advantage over a tool you can hand the exact literal.

That boundary is the honest positioning, and the shipped
[skill](plugins/git-why/skills/history-archaeology/SKILL.md) tells agents both halves:

- **cannot name the term** → `git why`
- **can name the term** → `git log -S`
- **current code, not history** → `zg`

### Scale and cost

| measurement                                  | result                        |
| -------------------------------------------- | ----------------------------- |
| Index across six real repos (56,781 commits) | 5.50–6.98 KB/record           |
| curl (30,000 commits)                        | 1.00 GiB, 5.74 KB/record      |
| Warm query, fresh process (p50 / p95, n=30)  | 483 ms / 494 ms               |
| Diff/evidence ingestion, real-repo ablation  | earns its cost, ΔHit@5 +0.375 |
| Tests                                        | 333 unit, 65 integration      |

### What does not work

Seven optimisations were implemented and measured; **none improved MRR** over
asking the question plainly: a prose-tuned embedding model, pseudo-relevance
feedback, a prose-commit penalty, caller-side query restatement, wider result
windows, structural expansion, and phrase fusion. The shipped default is the
best configuration among everything tried.

That is worth stating rather than hiding: it means no easy gain is being left
unclaimed, and the remaining headroom is in the embedding itself, which would
need a larger model or a learned reranker.

**It is also wrong most of the time.** Hit@5 of 0.287 means it misses roughly
seven hard questions in ten. It beats every alternative on those questions and
still fails on most of them. Treat results as leads to verify with `git show`,
never as established fact.

## When to use ordinary Git instead

Git Why is ranked retrieval over a semantic index. That's the wrong tool for
some jobs, and Git already has the right one:

- **A known exact string.** `git log -S` and `git log -G` are exhaustive.
  Keyword mode here is ranked, not exhaustive.
- **An exhaustive search.** `ripgrep` over a checkout, or `git grep`.
- **Verifying causality.** Similarity is not a timeline. Confirm ancestry
  with `git merge-base`, `git log --ancestry-path` and `git show`.

Git Why is for the case where you remember what happened but not what it was
called.

## Learn more

- **[Documentation site](https://alliecatowo.github.io/git-why/)** — guided
  install, how retrieval works, CLI reference, FAQ.
- **[`ROADMAP.md`](ROADMAP.md)** — pull requests, `gh why`, wikis, and what
  would need measuring before any of it ships.
- **[`docs/indexes.md`](docs/indexes.md)** — where indexes live, worktrees,
  submodules, monorepos, disk use, and the shared model cache.
- **[`docs/examples.md`](docs/examples.md)** — real output on real
  repositories, including a case where this is the wrong tool.
- **[`docs/plugin.md`](docs/plugin.md)** — the Claude Code plugin, its skill,
  and why it has no hook.
- **[`docs/decisions.md`](docs/decisions.md)** — what was tried and rejected,
  with the measurements. Seven optimisations that did not work.
- **[`docs/install.md`](docs/install.md)** — every install path and
  uninstall, including where the index and model cache live on disk.
- **[`docs/operations.md`](docs/operations.md)** — the full operational
  contract: durability, concurrency, exit codes, history scope, coverage
  limits.
- **[`docs/report.md`](docs/report.md)** — the benchmark report this
  README's numbers come from.
- **[`docs/spec.md`](docs/spec.md)** — the product specification.

## Development

```sh
mise setup     # install dependencies, then doctor
mise check     # format, lint, typecheck, unit tests
mise test:integration
mise test:package
mise site:build   # build the docs/marketing site in site/
```

See [`docs/contributing.md`](docs/contributing.md) for module ownership.

## License

Apache-2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
