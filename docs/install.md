# Installing Git Why

The package name on npm is **`@alliecatowo/git-why`** — plain `git-why` is an
unrelated, pre-existing package. The binary it installs is named `git-why`;
Git dispatches `git why <args>` to any executable named `git-why` on your
`PATH`, so no alias or shell configuration is required.

Every install path below produces the same thing: a `git-why` executable on
`PATH`. Pick whichever fits your environment.

## Requirements

- Node.js **>= 22.12** (check with `node -v`)
- Git (any reasonably current version)
- macOS or Linux, arm64 or x64. Windows is not claimed as a supported
  platform; use WSL2.

## Option 1: the install script

```sh
curl -fsSL https://alliecatowo.github.io/git-why/install.sh | sh
```

This is [`install.sh`](https://github.com/alliecatowo/git-why/blob/main/install.sh)
from this repository, also served from the docs site. It:

1. detects your OS/arch and refuses unsupported combinations with a clear
   message instead of failing halfway through;
2. checks for Git and for Node >= 22.12, telling you what to install if
   either is missing or too old;
3. prints the exact `npm install -g` command it is about to run;
4. checks whether the active npm global prefix is writable — if it isn't, it
   explains your options (a version manager, `npm config set prefix`, or
   running the install with `sudo` yourself) instead of silently escalating;
5. installs `@alliecatowo/git-why` globally with npm;
6. verifies `git-why` is on `PATH` and that `git why -h` actually resolves
   through Git's subcommand dispatch.

Read the script before piping it into a shell — that's good practice for any
installer, this one included. It's plain POSIX `sh`, no obfuscation.

Pin a version with `GIT_WHY_VERSION`:

```sh
GIT_WHY_VERSION=0.1.0 curl -fsSL https://alliecatowo.github.io/git-why/install.sh | sh
```

Re-running the script is safe; it reinstalls/updates in place.

## Option 2: npm

```sh
npm install -g @alliecatowo/git-why
```

Pin a version or tag the normal npm way:

```sh
npm install -g @alliecatowo/git-why@0.1.0
```

## Option 3: a GitHub release tarball

Every tagged release publishes the packed npm tarball as a release asset.
Install it directly, without going through the npm registry:

```sh
curl -fsSL -o git-why.tgz \
  https://github.com/alliecatowo/git-why/releases/download/vX.Y.Z/alliecatowo-git-why-X.Y.Z.tgz
npm install -g ./git-why.tgz
```

Replace `vX.Y.Z` / `X.Y.Z` with the release you want, and check the release
page for the asset's exact filename (`npm pack` names it
`<scope>-<name>-<version>.tgz`).

## Option 4: build from source

```sh
git clone https://github.com/alliecatowo/git-why.git
cd git-why
mise setup      # or: npm ci
npm run build
npm install -g .
```

This links your working tree's build output as the global `git-why`. Useful
for testing an unreleased change; rebuild (`npm run build`) after every
source change since the global install is a snapshot, not a symlink into
`src/`.

## Verifying the install

```sh
git-why --version
git why -h
```

Use `git why -h`, not `git why --help`. Git intercepts `--help` in the first
position after any subcommand name — built-in or external — and redirects it
to a man-page lookup rather than running the subcommand. Since Git Why ships
no man page, `git why --help` reports a missing manual page instead of
reaching the tool. This is Git's dispatch behavior for every external
subcommand, verified with `GIT_TRACE=1`, and is not something Git Why can
override. `git-why --help` (invoking the binary directly, bypassing Git's
dispatch) works, and so does `git why -h`.

## Uninstalling

### 1. Remove the package

```sh
npm uninstall -g @alliecatowo/git-why
```

### 2. Remove per-repository indexes (optional)

Each repository's index lives under that repository's Git **common**
directory (shared by all worktrees of the same repository), at:

```
<git-common-dir>/why/
```

Find your common directory and remove the index:

```sh
rm -rf "$(git rev-parse --git-common-dir)/why"
```

Run this inside each repository whose index you want to reclaim disk space
from. Deleting it is always safe — it's fully derived data; the next query
rebuilds it.

### 3. Remove the cached model (optional)

Model weights live in a **user-level** cache, shared across every repository
on the machine, never inside any project:

| Platform | Default location                                                 |
| -------- | ---------------------------------------------------------------- |
| macOS    | `~/Library/Caches/git-why/models`                                |
| Linux    | `$XDG_CACHE_HOME/git-why/models`, else `~/.cache/git-why/models` |

Or, regardless of platform, wherever `$GIT_WHY_MODEL_CACHE` points, if you
set it. Remove it with:

```sh
rm -rf ~/Library/Caches/git-why/models   # macOS
rm -rf ~/.cache/git-why/models           # Linux (default XDG location)
```

Deleting the cache is safe; the next query that needs the model re-downloads
it from a pinned, checksummed location.
