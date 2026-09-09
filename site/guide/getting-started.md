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
git why "when was request cancellation introduced?" -n 20 --sort=oldest
```

## Explicit index lifecycle

Normal use never requires these, but they exist for CI, cold starts, and
recovery:

```sh
git why index              # create or reconcile the index
git why status              # report index state, no mutation
git why status --json       # same, machine-readable
git why rebuild              # replace derived index data
git why gc                   # reconcile + compact, no downloads
```

## A note on `--help`

Use `git why -h`, not `git why --help`. Git intercepts `--help` in the first
position after any subcommand name — built-in or external — and redirects it
to a man-page lookup. Since Git Why ships no man page, `git why --help`
reports a missing manual page instead of reaching the tool. This is Git's
dispatch behavior for every external subcommand, not something Git Why can
override. `git-why --help` (calling the binary directly, not through Git)
works fine, and so does `git why -h`.

## Next

- [How it works](/guide/how-it-works) — hybrid retrieval, history scope,
  offline behavior.
- [CLI reference](/guide/cli-reference) — every flag and lifecycle command.
- [Benchmarks](/guide/benchmarks) — the measured numbers, with methodology.
