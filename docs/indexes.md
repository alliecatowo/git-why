# Indexes: where they live and how many you get

## One index per repository, shared by every worktree

The index lives at `<git-common-dir>/why/`. For an ordinary clone that is
`.git/why/`. For a linked worktree it is the **main** repository's `.git/why/`,
because `git rev-parse --git-common-dir` resolves there.

So five worktrees of one repository share one index. That is deliberate:
worktrees differ in which commit is checked out, not in which history exists,
and history is what gets indexed. Building five copies of the same commit graph
would cost five times the disk to answer identical questions.

The practical consequence: **build the index once, from any worktree, and every
worktree can query it.**

```console
$ cd ~/work/repo && git why index          # builds .git/why
$ cd ~/work/repo-feature-branch            # a linked worktree
$ git why "why do we retry twice"          # uses the same index, no rebuild
```

## What "current" means across worktrees

`git why status` reports freshness against the **refs snapshot**, not against
your checked-out commit. A worktree on an old branch is not stale; the index
tracks branches, remotes, tags and worktree HEADs together.

Fetching new commits into any worktree makes the shared index stale for all of
them. One `git why index --if-needed` from anywhere fixes it for everyone.

## Submodules are separate repositories

Each submodule has its own `.git`, so each gets its own index, and you must
build them separately. `git why` in a superproject does **not** search
submodule history — the commits genuinely are not in that history.

```console
$ git why index                    # superproject only
$ (cd vendor/thing && git why index)   # the submodule, separately
```

## Bare repositories and mirrors

A bare repository indexes normally; the index lives at `<bare>/why/`. There is
no worktree, which affects nothing — history is all that is read.

## Monorepos

One repository, one index, covering everything. Restrict by path at query time
rather than by building separate indexes:

```console
$ git why "why is auth retried twice" -- services/auth/
```

Path restriction filters which commits are eligible, so a monorepo does not
need per-package indexes and you do not pay to maintain them.

## Disk, concretely

Roughly 5.5–7 KB per record. Measured on six pinned public repositories:

| repository | commits | index    | KB/record |
| ---------- | ------- | -------- | --------- |
| curl       | 30,000  | 1.00 GiB | 5.74      |
| redis      | 12,110  | 450 MiB  | 6.92      |
| requests   | 6,494   | 106 MiB  | 5.50      |
| zod        | 3,210   | 162 MiB  | 6.52      |
| caddy      | 2,680   | 130 MiB  | 6.98      |
| ripgrep    | 2,287   | 87 MiB   | 6.94      |

`git why gc` reclaims space from superseded generations. Deleting `.git/why/`
is always safe — it is derived data, and the next search rebuilds it.

## The model cache is shared machine-wide

Embedding model files are cached once per machine, not per repository, under
the OS cache directory (`~/.cache/git-why/` on Linux, `~/Library/Caches/git-why/`
on macOS). Indexing your tenth repository does not re-download the model.

`git why --offline` refuses to download but will happily use an already-cached
model, which is the ordinary offline case.

## Cleaning up

```sh
git why gc                 # reclaim superseded generations
rm -rf .git/why            # remove this repository's index entirely
rm -rf ~/.cache/git-why    # remove the shared model cache
```

Nothing here is precious and nothing is committed — `.git/` is not tracked by
the repository it lives in.
