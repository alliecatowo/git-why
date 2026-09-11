# Getting started

## Requirements

- **Node.js >= 22.12** on macOS or Linux (arm64 or x64). Windows is not
  claimed; use WSL2.
- **Git**, obviously.

## Install

### One-liner

```sh
curl -fsSL https://alliecatowo.github.io/git-why/install.sh | sh
```

This detects your OS/arch, checks Node and Git, installs
`@alliecatowo/git-why` globally with npm, and verifies `git why` resolves
afterward. It will not silently `sudo`; if your npm prefix isn't writable it
explains your options instead. Set `GIT_WHY_VERSION` to pin a version.

### npm

```sh
npm install -g @alliecatowo/git-why
```

The package installs a `git-why` executable. Git dispatches
`git why <args>` to any executable named `git-why` on your `PATH` — that's
ordinary Git subcommand dispatch, not a Git Why-specific mechanism. No alias
or shell configuration is needed.

### Pin a version

```sh
GIT_WHY_VERSION=0.1.0 curl -fsSL https://alliecatowo.github.io/git-why/install.sh | sh
```

```sh
npm install -g @alliecatowo/git-why@0.1.0
```

Re-running the install script is safe; it reinstalls/updates in place.

### GitHub release tarball

Every tagged release publishes the packed npm tarball as a release asset,
so you can install without going through the npm registry:

```sh
curl -fsSL -o git-why.tgz \
  https://github.com/alliecatowo/git-why/releases/download/vX.Y.Z/alliecatowo-git-why-X.Y.Z.tgz
npm install -g ./git-why.tgz
```

Replace `vX.Y.Z` / `X.Y.Z` with the release you want, and check the release
page for the asset's exact filename.

### Build from source

```sh
git clone https://github.com/alliecatowo/git-why.git
cd git-why
mise setup      # or: npm ci
npm run build
npm install -g .
```

This installs a snapshot of your working tree's build output; rebuild
(`npm run build`) after every source change.

### Verify

```sh
git-why --version
git why -h
```

### Uninstall

```sh
npm uninstall -g @alliecatowo/git-why
```

Optionally reclaim derived data (both are safe to delete; the next query
rebuilds or re-downloads as needed):

```sh
rm -rf "$(git rev-parse --git-common-dir)/why"   # per-repository index
rm -rf ~/Library/Caches/git-why/models           # macOS model cache
rm -rf ~/.cache/git-why/models                   # Linux model cache
```

Every install path above produces the same thing: a `git-why` executable on
`PATH`. The full install reference, including npm-prefix troubleshooting, is
in
[`docs/install.md`](https://github.com/alliecatowo/git-why/blob/main/docs/install.md).

## Your first query

Run it inside any Git repository:

```sh
git why "why do we retry on a 429 here?"
```

The first ordinary query builds an index automatically. It reports model
download, extraction, and embedding as separate stages on stderr, then prints
ranked results to stdout: the commit, its author's actual words, and the
relevant diff.

Afterward, ordinary queries check freshness and index only newly reachable
commits — you don't run a separate "index" step in normal use.

## Narrowing a query

```sh
# Restrict to a path (a trailing / means a directory prefix).
git why "retry behavior" -- src/network/

# Bound by committer time.
git why "the old auth flow" --after=2024-01-01 --before=2024-06-01

# Bound by author.
git why "why is this disabled" --author=maya

# Keyword-only or vector-only, instead of the default hybrid.
git why "ETIMEDOUT" --text
git why "the fix for the flaky retry test" --semantic

# Chronological order instead of relevance (reorders, never widens).
git why "the retry rework" -n 20 --sort=oldest
```

For "when did this happen" there is something better than sorting. `--first`,
`--last` and `--removed` resolve an endpoint from the lineage table rather
than reordering the ranked list, so they can name a commit the ranking never
surfaced:

```sh
git why "when was request cancellation introduced" --first
git why "how did the retry logic evolve" --timeline
git why "who built the TLS layer" --owners
```

The answer prints above the results and names the term it was keyed on, so you
can judge it. See
[Ordering results](/guide/operations#ordinal-answers-first-last-removed).

## Explicit index lifecycle

Normal use never requires these, but they exist for CI, cold starts, and
recovery:

```sh
git why index               # create or reconcile the index
git why index --if-needed   # exit immediately if already current (cheap; safe in a loop)
git why status              # report index state, no mutation
git why status --json       # same, machine-readable
git why status --check-ready  # exit non-zero unless it can answer queries now
git why rebuild             # replace derived index data
git why gc                  # reconcile + compact, no downloads
```

## A note on `--help`

All three of these work:

```sh
git why -h        # the tool's own help
git-why --help    # the binary directly, bypassing Git
git why --help    # Git's man-page dispatch, which resolves to the shipped page
```

The third one is worth explaining, because it very nearly does not work. Git
intercepts `--help` in the first position after any subcommand name — built-in
or external — and rewrites it to a man-page lookup before the external command
is ever executed. A tool that ships no man page therefore answers
`git why --help` with "No manual entry", which is confusing and is not
something the tool can override.

Git Why ships `git-why.1`, generated from its own `-h` output so the two
cannot disagree, and the install script places it where that lookup finds it.
Packaging tests verify the dispatch end to end, and that every flag the tool
advertises has its own entry in the page.

## Next

- [How it works](/guide/how-it-works) — hybrid retrieval, history scope,
  offline behavior.
- [CLI reference](/guide/cli-reference) — every flag and lifecycle command.
- [Benchmarks](/guide/benchmarks) — the measured numbers, with methodology.
