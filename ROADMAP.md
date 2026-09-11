# Roadmap

Ordered by how much each would improve answers, not by how easy it is. Nothing
here is committed to a release; the point is to record the reasoning so a
future decision starts from it instead of from scratch.

## 1. Pull requests — the highest-value gap

This is the original motivation and remains the biggest hole.

A squashed merge leaves `Add retry logic (#1234)`. The pull request that
produced it contains the actual reasoning: _"tried exponential backoff first,
it amplified the outage because the endpoint has no idempotency key, so we
queue and dedupe instead."_ That sentence is the answer to "why do we queue
instead of retry", and **it is not in the repository at all.**

Everything this tool does well applies more strongly to PR bodies and review
threads than to commit messages, because they are longer, written in prose, and
argue about alternatives. The measured weakness — terse commits sharing no
vocabulary with how people ask — is largely a commit-message problem. PR text
does not have it.

**What to index:** PR title and body, review comments and review-thread
replies, and the linked issue's title and body when one is referenced. Not
bot comments, not CI noise, not reaction payloads.

**Why it is not just more documents:** a PR maps to commits. A result should be
able to say "this reasoning belongs to the commit you are looking at", which
means storing the PR-to-commit edge and letting a commit hit pull in its PR
discussion as evidence. That is the same shape as the existing evidence
records, so it fits the storage model rather than fighting it.

## 1b. The real prize: recovering history that Git threw away

The reason pull requests matter is bigger than "more text to index", and it is
worth stating separately because it changes what the tool is.

**Visible history is a lossy projection of what actually happened.** Squash
merges, rebases and force-pushes are designed to destroy the messy trail and
leave a clean one. The messy trail is the reasoning:

- A squashed commit says `Add retry logic (#1234)`. The six commits that went
  into it said `try exponential backoff`, `backoff amplifies load under
failure`, `revert backoff`, `queue and dedupe instead`. The squash deletes
  the three sentences that answer "why not just retry".
- A force-push after review replaces the version the reviewer objected to. The
  objection and the thing objected to are both gone from `git log`.
- A rebase rewrites SHAs, so anything referencing the pre-rebase commits
  dangles.

A pull request preserves all of it: the long-form body, the individual
pre-squash commits under `refs/pull/N/head`, the review threads attached to
specific lines of specific versions. **Squashed repositories are where this is
most valuable**, which is the opposite of the intuition that a clean history
needs less help.

**What that implies technically.** The interesting artefact is not a bag of PR
documents; it is an edge set:

```
squashed commit  --produced-by-->  PR #1234
PR #1234         --contains-->     6 original commits (refs/pull/1234/head)
review thread    --anchored-to-->  a line in a version that no longer exists
```

With those edges, a hit on the squashed commit can surface the internal
reasoning that the squash removed. The existing lineage table is already an
edge store over commits, so this extends a structure that exists rather than
adding a parallel one.

**Open pull requests are free upside.** Work that is proposed but not merged is
not in history at all, and "has anyone tried this already" is exactly the
question where the answer is often an open or a closed-unmerged PR. No other
local tool can answer it.

## 1c. Ancestry is harder than "what is reachable"

Following from the above, and relevant even without any GitHub integration.

`git why` currently treats history as the commits reachable from refs. That is
incomplete in ways that matter:

- **Dangling commits** from rebases and amends remain in the object database
  until `gc` collects them. These are real and plentiful: `git fsck --dangling`
  on a fresh zod clone reports 114. Pre-rebase versions of a change are
  frequently more explanatory than the rebased result. Note that a fresh clone
  has an almost empty reflog (3 entries), so the reflog is only useful in a
  repository someone has actually worked in — dangling-object discovery has to
  come from `fsck`, not from the reflog.
- **`refs/pull/*`** is NOT present in a standard clone — checked, rather than
  assumed. The default refspec is `+refs/heads/*:refs/remotes/origin/*` and a
  fresh clone of zod has zero pull refs. Fetching them needs an explicit
  refspec:

  ```sh
  git fetch origin '+refs/pull/*/head:refs/pull/*/head'
  ```

  That is cheap and needs no API token, so it is still the better first step
  than building a fetcher — but it is an opt-in action a user must take, not
  something already sitting in the clone.

- **Ordinal answers are already ancestry-based**, not timestamp-based, because
  rebases rewrite dates. That decision was right and this extends it: ancestry
  itself is partly hidden, not merely misordered.

**The honest risk:** reachability is a clean, well-defined scope, and
"everything in the object database" is not. Dangling objects are unreviewed,
possibly abandoned, and may contain work someone deliberately discarded.
Surfacing a reverted experiment as though it were current guidance would be
worse than missing it. Any such source has to be labelled distinctly in results
and probably opt-in, and that needs measuring on the 174-case corpus before it
is a default.

## 2. `gh why` as a sister command, sharing one index

The open design question, recorded with a position rather than left vague.

**Separate ingestion, unified retrieval.** The fetcher must be separate: it
needs a GitHub token, makes network calls, is rate limited, and goes stale on a
completely different schedule from local history. None of that belongs in a
command whose selling point is that it works offline against `.git`.

But the _query_ should not be split. Someone asking "why do we queue instead of
retry" does not know or care whether the answer is in a commit message or a
review comment, and making them run two tools and merge the results by hand is
the wrong seam. So:

```
gh why sync          # fetch PRs/reviews into the same index, needs a token
git why "<question>" # searches commits AND synced PR material
```

Results carry their source, and `--source=git|github` narrows when you do care.
Without a sync the tool behaves exactly as it does today, so the offline story
is unchanged for anyone who never runs it.

**Risk worth naming:** PR text is much larger than commit text, and adding a
large, prose-rich, differently-distributed corpus to the same index could
change ranking for existing commit-only queries. The 174-case corpus is the
regression check, and this must be measured against it before shipping, not
after.

## 3. Wikis — already supported, and nobody knows

A GitHub wiki is a Git repository (`<repo>.wiki.git`). `git why` works on it
today with no changes:

```sh
git clone git@github.com:owner/repo.wiki.git
cd repo.wiki && git why index && git why "why did we settle on this deploy flow"
```

This needs documentation and a worked example far more than it needs code. The
interesting half is that a wiki's _history_ answers "when did our guidance
change and why", which is a `git why` question, while its _current content_ is
a `zg` question. That is the same split the routing skill already teaches.

## 4. Releases and changelogs

Cheap and probably useful. Release notes are curated summaries that name
features in user-facing vocabulary — much closer to how people ask questions
than a commit message is. Tags are already in the ref scope; release _bodies_
live in the API and would arrive with the same sync as PRs.

Likely lower value than PRs because release notes describe _what_ shipped and
rarely _why_ an approach was chosen.

## 5. Issues — verify before building

GitHub's own issue search may already be semantic; I have not verified it and
will not build against an assumption.

**The check:** query a repository's issues through the GitHub API with phrasing
that shares no vocabulary with the issue text, the same way the 174-case corpus
is constructed, and see whether the right issue comes back. If GitHub already
does this well, indexing issues duplicates a working feature and adds staleness
for nothing.

Issues linked _from_ a PR are a separate and better case — they arrive as
context for a change rather than as standalone documents, and belong with (1).

## What would need measuring

Each of these is a retrieval change, so each gets the same treatment the
existing work got:

- The 174-case corpus is the **regression gate**. A change that improves PR
  questions while degrading commit questions is not obviously a win.
- A **new corpus** of PR-answerable questions, derived mechanically the same
  way: take merged PRs whose discussion contains a rationale, generate the
  question from the discussion, and gate out anything `gh search` already
  answers.
- **Honest baselines.** The competitor is not "nothing". It is GitHub search,
  `gh pr list --search`, and a human scrolling the PR. If those win, that is
  the finding.

## Known limits that are not on this list

Recorded so they are not mistaken for oversights:

- **The semantic gap is the real ceiling.** Seven optimisations were measured
  and rejected (`docs/decisions.md`). Closing it needs a larger embedding model
  or a learned reranker, both outside the current dependency budget. PR
  indexing helps by giving the embedder better text to work with, not by fixing
  the embedder.
- **`git log -S` wins when you can name the symbol** (0.950 vs 0.350). No
  amount of new corpora changes that, and the skill should keep saying so.
