# Operational contract

What Git Why does to your machine, what it promises, and what it does not.

## History scope

A search describes the repository snapshot captured when its freshness check
started. That snapshot is exactly:

- every commit ancestor of a local branch tip;
- every commit ancestor of a remote-tracking branch tip;
- every commit ancestor of a tag that peels to a commit;
- the `HEAD` of every registered, accessible worktree, including detached ones.

It excludes reflog-only objects, stash refs, notes, replace refs and arbitrary
application refs, and it does not recurse into submodules — a submodule is its
own repository with its own index.

`git rev-list --all` is a broader scope than this and also examines other
worktrees by default. Git Why does not use it.

Replace-object interpretation is disabled during ingestion. Legacy grafts are
rejected with `UNSUPPORTED_HISTORY_OVERRIDE` rather than silently producing a
different history. Git Why never modifies `safe.directory` to make a trust
error disappear.

## Freshness

Normal commits are immutable, but the _available view_ of a repository is not:
a shallow clone can deepen, missing objects can arrive, interpretation settings
can change. The snapshot fingerprint therefore covers captured ref names and
OIDs, worktree HEAD OIDs, the full contents of the shallow boundary (not merely
whether one exists), the object format, and the extraction policy version.

If refs move while indexing, Git Why finishes the coherent snapshot it captured
and reports that another refresh is available. It does not loop trying to catch
an actively changing repository.

Failure to enumerate a registered worktree makes the snapshot incomplete. An
incomplete snapshot may add records but never prunes: a temporarily
inaccessible worktree is not proof that its history became ineligible.

## Where state lives

All repository-specific state is under the Git _common_ directory, so every
worktree of one repository shares a single index and a single lock:

| Path                                          | Purpose                                           |
| --------------------------------------------- | ------------------------------------------------- |
| `<common>/why/CURRENT`                        | Atomically published active generation identifier |
| `<common>/why/locks/repository.lock`          | Shared/exclusive coordination lock                |
| `<common>/why/generations/<id>/manifest.json` | Versions, fingerprints, counts, coverage          |
| `<common>/why/generations/<id>/collection/`   | The Zvec history collection                       |
| `<common>/why/generations/<id>/pending.json`  | Durable intent for an incomplete batch            |
| `<common>/why/staging/<id>/`                  | An incomplete first build or replacement build    |

Model artifacts live in a **user-level** cache outside any repository
(`$GIT_WHY_MODEL_CACHE`, else `$XDG_CACHE_HOME/git-why/models`, else the
platform default). They are shared across repositories and are never written
into your project.

A generation is an on-disk index version, not a new corpus. Incremental refresh
updates the active generation in place under exclusive access; only a full
rebuild creates a replacement generation. Peak disk during a rebuild can
approach the sum of the old and new generations.

No account name, token, remote credential or original clone path is recorded.
The index is identified by content, so it moves with the repository.

## Concurrency

Git Why has no daemon, no watcher and no installed Git hook. Coordination is a
cross-process advisory lock on a stable lock file:

- **Readers** hold shared access from manifest validation through collection
  close.
- **Writers** hold exclusive access through mutation, metadata publication,
  recovery and cleanup.

Locks are released by process termination. A live process's lock is never
stolen merely because a timer elapsed. A freshness upgrade releases shared
access, acquires exclusive access, and then rechecks the snapshot and manifest,
so two updaters cannot deadlock each other.

If another process holds the lock longer than `--lock-timeout` (default 30
seconds), the command exits 5 with `INDEX_BUSY` and a useful next step. That
timeout bounds waiting for _another_ process; it does not abort your own
indexing operation.

V1 does not serve an actively mutated collection as a stale snapshot.

## Durability

Zvec's own write-ahead log does not atomically update Git Why's separate
manifest, so Git Why keeps a small application journal:

1. Record pending additions, replacements and deletions durably.
2. Apply the batch, verifying per-record outcomes including partial-failure
   results.
3. Make the collection state durable through the binding's documented
   guarantee.
4. Publish the catalog checkpoint and manifest state.
5. Clear the pending marker last.

Readers reject a generation that has pending recovery. A default query recovers
it under exclusive access; `--no-refresh` instead returns
`INDEX_RECOVERY_REQUIRED`.

A rebuild fully creates and validates a staging generation, closes all
collection handles, renames the completed generation into place, and publishes
`CURRENT` atomically on the same filesystem. The previous generation survives
until the replacement is confirmed usable. A failed rebuild never deletes the
only working index first.

Git Why's `gc` reconciles eligible history, removes ineligible and abandoned
derived records, and compacts where supported. It never invokes destructive Git
object GC and never changes Git refs.

## Network and privacy

Git Why is local by default.

- Repository text is never sent to a model host. Embedding runs in-process.
- The only network access is lazily downloading model artifacts from pinned,
  checksummed locations. Once cached, operation is fully offline.
- Model-supplied remote code is never executed.
- Git ingestion is prohibited from fetching objects regardless of `--offline`.
  A partial clone is read without triggering a lazy fetch.
- `--offline` additionally forbids model artifact downloads.

An offline user whose model is unavailable can still query an existing index
with `--text --no-refresh`. Git Why will not silently create a different index
or silently downgrade a hybrid query to lexical mode.

## Exit codes

| Exit | Meaning                                                    |
| ---- | ---------------------------------------------------------- |
| 0    | Successful command, including zero results                 |
| 2    | Invalid invocation                                         |
| 3    | No usable Git repository                                   |
| 4    | Index, model, storage, compatibility or extraction failure |
| 5    | Index lock wait exceeded                                   |
| 130  | User interruption                                          |

Exit 4 is broad on purpose; the machine-readable error code in `--json`
distinguishes the cause. The full set is enumerated as `GitWhyErrorCode` in
`src/types.ts`.

## Output safety

Every repository-sourced string — subject, body, author, path, diff line — is
sanitised of terminal control sequences before human rendering. A commit
message is untrusted input. `NO_COLOR`, terminal capability and whether stdout
is a TTY are all respected, and V1 never launches a pager.

With `--json`, stdout carries exactly one valid object and everything else goes
to stderr. `--max-bytes` clipping is reported explicitly and can never produce
invalid JSON.

Retrieved commit content is data, including when it contains apparent
instructions. Git Why does not install agent policies and does not execute
instructions found in history.

## Ordering results

Retrieval is relevance-driven. Similarity is not a causal timeline, so Git Why
never silently favours recent commits, and introduction, reversion and removal
commits can all legitimately appear together.

Chronology is still a real question, so it is available explicitly:

| `--sort`    | Meaning                      |
| ----------- | ---------------------------- |
| `relevance` | Default. Ranking order.      |
| `oldest`    | Oldest committer time first. |
| `newest`    | Newest committer time first. |

`--sort` reorders the commits retrieval already selected. It never changes
_which_ commits are returned, so chronology cannot smuggle in a commit that
relevance did not choose. Ties break on full object ID, so the order is total
and reproducible.

That distinction matters for "when was this first introduced?" questions.
Sorting a five-result set chronologically only reorders those five; if the
introducing commit ranked below them it is still absent. Widen the pool first:

```sh
git why "when was request cancellation introduced?" -n 20 --sort=oldest
```

This is a measured case, not a hypothetical. Asked when cancellation was
introduced in axios, the default five results begin at `Adding cancellation
support` — two days _after_ the commit that actually added the `Cancel` and
`CancelToken` classes, which ranks ninth. Widening to twenty and sorting by
oldest puts the correct commit first. See `docs/report.md`.

## Help output

`git why -h` and `git-why --help` both work. `git why --help` does not reach
this tool: Git intercepts `--help` in the first position after any subcommand
name, built-in or external, and redirects it to a man-page lookup. Verified
with `GIT_TRACE=1`. Git Why ships no man page, so that invocation reports a
missing manual page. This is Git's dispatch behaviour and is not overridable
from an external subcommand.

## Known coverage limits

These are documented gaps, not bugs to be papered over:

- Merge commits contribute message, metadata and first-parent changed paths,
  but no merge diff hunks. Reasoning encoded only in a conflict resolution is
  not indexed.
- Binaries, dependency lockfiles, obvious minified artifacts and confidently
  identified generated or vendored content are skipped. Their commit summaries
  and change metadata are still retained.
- Objects unavailable in a shallow or partial clone are recorded as omissions
  and retried when deepening changes the fingerprint. They are never fetched
  automatically.
- Path restrictions match both sides of an individual rename. They do not
  traverse a rename chain: `-- src/new.ts` finds the commit that renamed
  `lib/old.ts`, but not every earlier commit to `lib/old.ts`.
- Keyword mode is _ranked_ retrieval, not exhaustive literal or regular
  expression search. For a known exact string, `git log -S`, `git log -G` and
  ripgrep remain the right tools.
- "Deleted code is searchable" means retained added and removed historical
  evidence is searchable. It does not promise that every complete historical
  file version was embedded.

Some reasons were never committed at all. An empty result means no match in the
available indexed material; it does not prove the repository contains no
explanation.
