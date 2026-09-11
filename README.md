# Git Why

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node.js >= 22.12](https://img.shields.io/badge/node-%3E%3D22.12-blue.svg)](https://nodejs.org/)
[![CI](https://github.com/alliecatowo/git-why/actions/workflows/ci.yml/badge.svg)](https://github.com/alliecatowo/git-why/actions/workflows/ci.yml)

**`git blame` tells you who changed the code. `git why` finds the history
that explains it.**

Local-first semantic + full-text search over Git history. It returns the
actual commit, its author's real words, and the relevant diff. It retrieves
evidence; it does not generate an explanation of its own.

Real output from `mise run demo`, which rebuilds a small fixture repository
from `bench/fixtures/demo/build.mjs` and runs these two queries against it.
Nothing here is hand-written, and you can reproduce it in one command.

For output against **real repositories** — curl, zod, redis — including a
worked case where this is the wrong tool, see
[`docs/examples.md`](docs/examples.md) or the
[recorded terminal sessions](https://alliecatowo.github.io/git-why/guide/examples).

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

## Use it with an agent

Two plugins ship in `plugins/`:

| plugin         | what you get                                                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `git-why`      | The MCP server, a routing skill, and an index-management skill.                                                                        |
| `git-why-full` | The same, plus [`zg`](https://zvec.org) for current-code search and a history-explorer agent for questions that need several searches. |

OpenCode users get `opencode/` — an `opencode.json` with the MCP registration
and an `AGENTS.md` fragment.

What the skill actually teaches is **when not to reach for history**. It tells
an agent to use `git log -S` when it can name the symbol, because that is a
case this tool measurably loses (Hit@10 0.950 against 0.350), and to use code
search rather than history for the current state of the code. A skill that
claims its own tool is always best makes an agent worse at its job.

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

Every number below is written into this file by `bench/report.mjs` from raw
run data, and CI fails if it drifts — no figure here was typed by hand. Full
methodology, limits, and the negative results are in
[`docs/report.md`](docs/report.md).

### Against the tools you would otherwise use

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

### Where it loses

<!-- generated:crossfile -->

When you can name the symbol, use pickaxe search instead. On cross-file causal
questions, `git log -S` scores Hit@10 **0.950** against `git why`'s 0.350.
Semantic search has no advantage over a tool you can hand the exact literal.

<!-- /generated:crossfile -->

That boundary is the honest positioning, and the shipped
[skill](plugins/git-why/skills/history-archaeology/SKILL.md) tells agents both halves:

- **cannot name the term** → `git why`
- **can name the term** → `git log -S`
- **current code, not history** → `zg`

### Scale and cost

### Does it help an agent?

<!-- generated:agent -->

Retrieval quality is not the product. The question is whether an agent answering a real
question does it more accurately, or in fewer turns, with the tool than without. Four arms
over the same frozen tasks, paired per task, with token counts reconciled against the
provider's own accounting database.

| model                 | paired n | accuracy W-L | median tool calls saved |
| --------------------- | -------: | -----------: | ----------------------: |
| claude-haiku-4-5      |        9 |          1-1 |                       1 |
| claude-sonnet-5       |        8 |          0-0 |                       1 |
| deepseek-v4-flash     |        8 |          0-0 |                       3 |
| gemini-2.5-flash-lite |        6 |          2-1 |                       1 |
| gemini-3.1-flash-lite |        7 |          2-0 |                       1 |

Every model reached the answer in the same number of turns or fewer. At single-digit paired n per model this is descriptive, not significant, and it is reported that way
deliberately — the direction is consistent, the magnitude is not established. Full method and per-arm figures in the benchmark report.

<!-- /generated:agent -->

Method, per-arm figures and the registered hypothesis: [`docs/report.md`](docs/report.md#5-agent-benchmark-does-this-help-an-agent-and-which-agents).

<!-- generated:scale -->

| measurement                                               | result                        |
| --------------------------------------------------------- | ----------------------------- |
| Index across 6 real repos (56,781 commits)                | 5.50–6.98 KB/record           |
| curl (30,000 commits)                                     | 1.00 GiB, 5.74 KB/record      |
| Warm query on curl-curl (30,000 commits), p50 / p95, n=20 | 807 ms / 1199 ms              |
| The same query on a 135-commit fixture                    | 477 ms / 508 ms               |
| Diff/evidence ingestion, real-repo ablation               | earns its cost, ΔHit@5 +0.375 |

<!-- /generated:scale -->

### What does not work

Seven optimisations were implemented and measured; **none improved MRR** over
asking the question plainly: a prose-tuned embedding model, pseudo-relevance
feedback, a prose-commit penalty, caller-side query restatement, wider result
windows, structural expansion, and phrase fusion. The shipped default is the
best configuration among everything tried.

That is worth stating rather than hiding: it means no easy gain is being left
unclaimed, and the remaining headroom is in the embedding itself, which would
need a larger model or a learned reranker.

<!-- generated:honesty -->

**It is also wrong most of the time.** Hit@5 of 0.287 means it misses roughly
seven hard questions in ten. It beats every alternative on those questions and
still fails on most of them. Treat results as leads to verify with `git show`,
never as established fact.

<!-- /generated:honesty -->

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
- **[`docs/plugin.md`](docs/plugin.md)** — both plugins, the MCP tools, the
  skills, and why there is no hook.
- **[`docs/decisions.md`](docs/decisions.md)** — what was tried and rejected,
  with the measurements. Seven optimisations that did not work.
- **[`docs/install.md`](docs/install.md)** — every install path and
  uninstall, including where the index and model cache live on disk.
- **[`docs/operations.md`](docs/operations.md)** — the full operational
  contract: durability, concurrency, exit codes, history scope, coverage
  limits.
- **[`docs/report.md`](docs/report.md)** — the benchmark report this
  README's numbers come from.
- **[`docs/spec.md`](docs/spec.md)** — the build specification this was
  written against. Source comments cite its sections, so it is kept as
  provenance rather than as user documentation.

## Development

```sh
mise setup             # install dependencies, then doctor
mise check             # format, lint, typecheck, protocol hash, unit tests
mise test:integration  # real repositories, real storage, real locks
mise test:package      # pack, install into a clean prefix, invoke through Git
mise site:build        # build the docs/marketing site in site/
mise tasks             # everything else, including every benchmark
```

Numbers in `README.md`, `site/index.md` and `docs/report.md` are written by
`bench/report.mjs` from raw run data — CI fails if you edit one by hand. The
man page, the site's CLI reference and all three shell completions are checked
against `git why -h`, which is the only place the flag set is defined.

See [`docs/contributing.md`](docs/contributing.md) for module ownership and how
to cut a release.

## License

Apache-2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
