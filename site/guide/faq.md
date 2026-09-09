# FAQ & limitations

## Does Git Why send my code anywhere?

No. Repository text is never sent to a model host; embedding runs
in-process. The only network access is a lazy, checksummed download of model
weights on first use. After that, it's fully offline. See
[Offline and privacy](/guide/how-it-works#offline-and-privacy).

## Why does it sometimes return something irrelevant?

Git Why has no refusal path: it always returns its `n` closest-ranked
commits, even when nothing in history actually answers the question. On our
own no-evidence test cases (queries describing a decision the fixture history
never made), the tool still returned a full page of results every time — it
surfaced _something_, not _the reason_, because no reason was recorded. Read
the returned commit critically; a low-confidence match is still just a match.

## Is this a blinded benchmark?

No, and we say so directly: the hand-authored real-repository cases (on
expressjs/express and axios/axios) were written by the same system that
built the tool. That's real-repository evidence, not an independently
authored or blinded test set. See [Benchmarks](/guide/benchmarks) for the
full caveat and numbers.

## Why does the synthetic benchmark say 100% and the real one say 90%?

Because the synthetic fixtures are easy relative to their own generator, and
Hit@5 saturates on them — all three retrieval modes hit 100%, which means
Hit@5 stops discriminating between them. Real repositories don't saturate:
Hit@5 is 90%, Hit@1 is 60%, MRR is 0.733 on 10 answerable hand-authored
cases. Treat the real-repository numbers as the informative ones. Full
methodology in the [benchmark report](/guide/benchmarks).

## Has an agent-usefulness study been run?

Not yet. The harness exists; the pilot run does not. This will be reported
here (and in `docs/report.md`) once it exists — including if it's negative or
inconclusive.

## `git why --help` says "no manual entry" — is that a bug?

No. Git intercepts `--help` in the first position after any subcommand name
(built-in or external) and redirects it to a man-page lookup, before your
subcommand ever runs. Since Git Why ships no man page, that lookup fails.
Use `git why -h`, or call the binary directly: `git-why --help`. Verified
with `GIT_TRACE=1`; this is Git's dispatch behavior, not something an
external subcommand can override.

## Does it work on Windows?

Not claimed. Support is macOS and Linux, arm64 or x64, Node >= 22.12. Use
WSL2 on Windows.

## What isn't indexed?

- Merge diff hunks (merge commits still contribute message, metadata, and
  first-parent changed paths).
- Binaries, lockfiles, minified artifacts, and confidently identified
  generated/vendored content (their commit summaries are still retained).
- Reflog-only objects, stash refs, notes, replace refs, and submodule
  history (a submodule is its own repository with its own index).

Full list: [How it works — known coverage limits](/guide/how-it-works#known-coverage-limits).

## Where does state live, and how do I remove it?

Index state lives under your repository's Git common directory (so worktrees
share one index); model weights live in a user-level cache outside any
repository. Exact paths and uninstall steps are in
[`docs/install.md`](https://github.com/alliecatowo/git-why/blob/main/docs/install.md#uninstalling).
