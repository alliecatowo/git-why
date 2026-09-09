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

Every number below is generated from raw run data, not typed by hand — see
[`docs/report.md`](docs/report.md) for the full methodology, protocol, and
caveats.

| Measurement                                                         | Result                            |
| ------------------------------------------------------------------- | --------------------------------- |
| Index `expressjs/express` (6167 commits)                            | 126 MiB index                     |
| Index `axios/axios` (2185 commits)                                  | 80.8 MiB index                    |
| Warm query, fresh process (p50 / p95, 30 samples)                   | 496 ms / 509 ms                   |
| Real-repository retrieval (10 hand-authored cases, express + axios) | Hit@5 90%, Hit@1 60%, MRR 0.733   |
| Tests                                                               | 290 unit, 65 integration, passing |

Two honest caveats, spelled out fully in the report: the real-repository
cases above were hand-authored by the same system that built the tool, so
this is real-repository evidence, not a blinded study; and the synthetic
fixture benchmark saturates at 100% Hit@5, which is not a meaningful number
and is not the headline here on purpose. An agent-usefulness pilot has not
been run yet.

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
