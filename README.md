# Git Why

**Semantic archaeology for Git.** `git blame` tells you who changed the code.
`git why` finds the history that explains it.

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

The query and the commit share no vocabulary. "reconnecting subscribed twice"
finds "Stop duplicate subscriptions after reconnect" because the index carries
the meaning of the change, not just its words.

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
npm install -g @alliecatowo/git-why
```

The package installs a `git-why` executable, which Git dispatches as the
subcommand `git why`. No alias setup is needed.

## Three useful queries

```sh
# Ask in your own words. The answer is a commit, not a summary.
git why "why do we keep the session when the refresh token is empty?"

# Narrow to the code you are actually looking at.
git why "retry behavior" -- src/network/

# Find something that no longer exists.
git why "the queue before we moved to workers"
```

## What it actually does

Git Why retrieves **historical evidence**. It does not generate an explanation
of its own.

Its corpus is your reachable Git commits: their original messages and metadata,
their changed paths, and bounded evidence from their diffs. Added and removed
code both count — a deletion is often the best answer to a question about an
implementation that no longer exists.

What comes back is the commit, its author's actual words, and the relevant
diff. Historical messages are assertions by their authors, not infallible
accounts of intent, and some reasons were never committed at all. Git Why will
not manufacture those.

## First run

The first ordinary query builds the index automatically, reporting model
download, extraction and embedding as separate stages on stderr. Afterwards,
ordinary queries check freshness and index newly reachable commits.

The index lives under your repository's Git common directory, so every worktree
of the same repository shares one index. Model weights live in a user-level
cache shared across repositories, never inside your project.

`--no-refresh` gives predictable read-only behaviour against an existing index.

## Options

| Flag                    | Meaning                                                                        |
| ----------------------- | ------------------------------------------------------------------------------ |
| `-n <1-50>`             | Distinct commits to return. Default 5.                                         |
| `-- <path>...`          | Restrict to literal historical paths; a trailing `/` means a directory prefix. |
| `--after=`, `--before=` | Committer-time bounds. `YYYY-MM-DD` is interpreted as UTC.                     |
| `--author=`             | Case-insensitive literal substring of author name or email.                    |
| `--text`                | Keyword search only.                                                           |
| `--semantic`            | Vector search only.                                                            |
| `--json`                | One valid JSON object on stdout; diagnostics on stderr.                        |
| `--no-refresh`          | Never create, mutate, recover or compact the index.                            |
| `--offline`             | Additionally forbid model artifact downloads.                                  |
| `--max-bytes`           | Bound rendered output. Default 16 KiB, maximum 256 KiB.                        |
| `--lock-timeout`        | Seconds to wait for another process. Default 30.                               |
| `--query`               | Disambiguate a query that looks like a command or an option.                   |

Lifecycle commands: `git why index`, `status`, `status --json`, `rebuild`,
`rebuild --use-default-model`, `gc`.

For help, use `git why -h` or `git-why --help`. Git itself intercepts
`--help` in the first position after a subcommand name and redirects it to a
man-page lookup, so `git why --help` reports a missing manual page rather than
reaching this tool. That is Git's behaviour for every external subcommand, not
something Git Why can override.

## Offline use and privacy

Git Why is local by default. Repository text is never sent to a model host;
embedding runs in-process. The only network access is a lazy, checksummed
download of the model weights, after which operation is fully offline. Git
ingestion never fetches objects, so reading a partial clone will not trigger a
fetch.

An offline user whose model is unavailable can still query an existing index
with `--text --no-refresh`. Git Why will not silently create a different index
or silently downgrade a hybrid query to keyword mode.

## History scope

Ancestors of local branches, remote-tracking branches and tags that peel to
commits, plus the `HEAD` of every registered worktree. Not reflog-only objects,
stash refs, notes or replace refs. Not submodules — a submodule is its own
repository with its own index.

## When to use ordinary Git instead

Git Why is ranked retrieval over a semantic index. That is the wrong tool for
some jobs, and Git already has the right one:

- **A known exact string.** `git log -S` and `git log -G` are exhaustive.
  Keyword mode here is ranked, not exhaustive.
- **An exhaustive search.** `ripgrep` over a checkout, or `git grep`.
- **Verifying causality.** Similarity is not a timeline. Confirm ancestry with
  `git merge-base`, `git log --ancestry-path` and `git show`.

Git Why is for the case where you remember what happened but not what it was
called.

## Supported platforms

See [`docs/operations.md`](docs/operations.md) for the full operational
contract, and the benchmark report for measured results. Support is claimed
only for the OS, architecture and runtime combinations that pass the real lock
and package tests; network filesystem locking is outside the initial guarantee.

## Limitations

Documented gaps, not bugs: merge commits contribute metadata but no merge diff
hunks; binaries, lockfiles, minified artifacts and confidently identified
generated content are skipped while their commit summaries are retained; path
restrictions match both sides of an individual rename but do not traverse a
rename chain. The full list is in
[`docs/operations.md`](docs/operations.md#known-coverage-limits).

An empty result means no match in the available indexed material. It does not
prove your repository contains no explanation.

## Development

```sh
mise setup     # install dependencies, then doctor
mise check     # format, lint, typecheck, unit tests
mise test:integration
mise test:package
```

See [`docs/contributing.md`](docs/contributing.md) for module ownership and
[`docs/decisions.md`](docs/decisions.md) for decisions resolved by executed
experiments rather than assumption.

## License

Apache-2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
