---
name: index-management
description: Use when git why reports no index, a stale index, or an error about the index - and before running searches in a repository for the first time. Covers building, refreshing, checking readiness, and reclaiming disk.
---

# Keeping the index usable

`git why` searches an index under `.git/why/`. It is derived data: safe to
delete, rebuilt from history, never committed, and removed with the repository.

## The one command worth memorising

```sh
git why index --if-needed
```

Idempotent. Builds when the index is missing or stale, does nothing when it is
current — about 0.2 seconds on an already-current 3,000-commit repository
against minutes for a rebuild. Safe to call before any search without checking
first, which is the point: the alternative is scripting
`status --check-ready || index` and getting it wrong in one of two expensive
directions.

## Checking state

```sh
git why status                  # human summary
git why status --json           # machine-readable
git why status --check-ready    # exit 0 only if current and complete
```

`--check-ready` is for scripts and CI. It exits 3 when the index is missing,
stale for the current refs, or does not cover every reachable commit.

Note that `coverage` will report excluded and failed files on any real
repository — lockfiles, binaries, generated and oversized content are skipped
by policy. That is the extraction policy working, not damage, and readiness
does not require zero omissions.

## When to rebuild rather than refresh

```sh
git why index      # incremental: new commits only
git why rebuild    # from scratch
```

Refresh handles ordinary new commits. Rebuild when history itself was rewritten
underneath the index — a force-push, a rebase of shared branches, a filter-repo
run — or after upgrading `git why` across a format change, which the tool will
tell you about rather than leaving you to guess.

## Disk

```sh
git why gc         # drop abandoned generations
```

Roughly 5.5 to 7 KB per record: about 1 GiB for a 30,000-commit repository like
curl, 162 MiB for a 3,200-commit one. Indexing costs a few seconds per thousand
commits, so a large repository is minutes and a normal one is seconds.

`gc` reclaims space from superseded generations. Deleting `.git/why/` entirely
is also safe; the next search rebuilds it.

## When something is wrong

An index error is usually one of three things, and the message says which:

- **missing** — nothing built yet. `git why index`.
- **stale** — refs moved since the last build. `git why index`.
- **format change** — the tool was upgraded across an incompatible version.
  `git why rebuild`.

If a search fails with a storage error, `git why rebuild` resolves nearly
everything, at the cost of a full re-index. Nothing in `.git/why/` is precious.
