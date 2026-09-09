# How it works

## Retrieval, not generation

Git Why retrieves **historical evidence**. It does not generate an
explanation of its own. Its corpus is your reachable Git commits: their
original messages and metadata, their changed paths, and bounded evidence
from their diffs. Added and removed code both count — a deletion is often the
best answer to a question about an implementation that no longer exists.

What comes back is the commit, its author's actual words, and the relevant
diff. Historical commit messages are assertions by their authors, not
infallible accounts of intent, and some reasons were never committed at all.
Git Why will not manufacture those. An empty (or unconvincing) result means no
match in the available indexed material — it does not prove your repository
contains no explanation.

## Hybrid retrieval: FTS + vector, fused with RRF

Two independent retrieval branches run over the same commit-level records:

- **Lexical (full-text)** — a keyword index over commit messages, paths, and
  retained diff evidence. Good at exact identifiers, error strings, and
  vocabulary the commit itself uses.
- **Semantic (vector)** — a 256-dimension static embedding
  (`minishlab/potion-code-16M-v2`, Model2Vec, MIT license) of the same
  material. Good at paraphrase: a query and its answer can share no
  vocabulary at all.

By default (`hybrid` mode) both branches retrieve their own top candidates,
and the results are combined with **Reciprocal Rank Fusion (RRF, k=60)** —
the standard constant from the original Cormack et al. paper, not tuned
against our own dataset. RRF credits a document for ranking well in _either_
list without requiring the two branches' raw scores to be comparable, which
matters here: FTS relevance scores and cosine similarity are not on the same
scale.

`--text` and `--semantic` bypass fusion and run a single branch, which is
useful when you already know which kind of match you want, or when the model
is unavailable (see [Offline](#offline)).

## Ranking unit: the commit

Retrieval is fused and returned at the **commit** level, not the chunk or
diff-hunk level. A commit's message, metadata, and evidence all contribute to
whether that commit ranks — you get back a coherent commit to read, not a
disconnected fragment.

## History scope

A search covers exactly:

- every commit ancestor of a local branch tip;
- every commit ancestor of a remote-tracking branch tip;
- every commit ancestor of a tag that peels to a commit;
- the `HEAD` of every registered, accessible worktree, including detached
  ones.

It excludes reflog-only objects, stash refs, notes, and replace refs, and it
does not recurse into submodules — a submodule is its own repository with its
own index. This is narrower than `git rev-list --all`, deliberately.

## Filters

`-- <path>...` restricts to literal historical paths (a trailing `/` means a
directory prefix); `--after=` / `--before=` bound committer time (UTC,
ISO-8601: `--after=` is at-or-after, `--before=` is strictly-before);
`--author=` matches a case-insensitive substring of author name
or email. Filters apply before ranking, not as a post-hoc re-sort.

## Worktrees

The index lives under your repository's Git **common** directory, so every
worktree of the same repository shares one index and one lock. Indexing one
worktree does not require re-indexing another.

## Offline and privacy

Git Why is local by default:

- Repository text is never sent to any model host. Embedding runs
  in-process.
- The only network access is a lazy, checksummed download of model weights.
  After that, operation is fully offline.
- Git ingestion never fetches objects, with or without `--offline` — reading
  a partial clone will not trigger a fetch.
- `--offline` additionally forbids model artifact downloads.

An offline user whose model is unavailable can still query an existing index
with `--text --no-refresh`. Git Why will not silently create a different
index or silently downgrade a hybrid query to keyword mode on your behalf.

Model weights live in a user-level cache
(`$GIT_WHY_MODEL_CACHE`, else `$XDG_CACHE_HOME/git-why/models`, else the
platform default), shared across repositories — never inside your project.

## When not to use this

Git Why is ranked retrieval over a semantic index. That's the wrong tool for
some jobs, and Git already has the right one:

- **A known exact string.** `git log -S` and `git log -G` are exhaustive.
  Keyword mode here is ranked, not exhaustive — it can omit a real match that
  scored low.
- **An exhaustive search.** `ripgrep` over a checkout, or `git grep`.
- **Verifying causality.** Similarity is not a timeline. Confirm ancestry
  with `git merge-base`, `git log --ancestry-path`, and `git show`.

Git Why is for the case where you remember what happened but not what it was
called.

## Known coverage limits

- Merge commits contribute message, metadata, and first-parent changed paths,
  but no merge diff hunks. Reasoning encoded only in a conflict resolution is
  not indexed.
- Binaries, dependency lockfiles, minified artifacts, and confidently
  identified generated/vendored content are skipped for embedding; their
  commit summaries and change metadata are still retained.
- Path restrictions match both sides of an individual rename, but do not
  traverse a rename chain: `-- src/new.ts` finds the commit that renamed
  `lib/old.ts`, not every earlier commit to `lib/old.ts`.
- The full operational contract — durability, concurrency, exit codes, and
  more coverage limits — is in
  [Operations & guarantees](/guide/operations).
