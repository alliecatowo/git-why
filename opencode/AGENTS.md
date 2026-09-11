# Git Why for OpenCode

Drop-in guidance for OpenCode agents. Copy the sections you want into your
project's `AGENTS.md`, or point `opencode.json` at the config below.

## Tool routing

Three tools, three questions. Picking wrong is the common failure, and these
boundaries are measured, not guessed — 174 questions from six real repositories
plus a cross-file corpus.

- **`zg "<query>"`** — where something is in the CURRENT code.
- **`git why "<question>"`** — WHY it is that way. On questions you cannot turn
  into a search term it scores ~18x `git log --grep`.
- **`git log -S<symbol>`** — what touched a KNOWN identifier. Beats semantic
  search 0.950 to 0.350. If you can see the name, use this.

Do not reach for `git why` when you already have the identifier, and do not
reach for `zg` to answer a "why" — a reverted approach or an abandoned design
is not in the working tree at all.

## Before searching

```sh
git why index --if-needed
```

Idempotent and ~0.2s when the index is current. Safe to run unconditionally.

## Asking well

Plain phrasing beats technical phrasing, which is the opposite of the natural
instinct. Restating a question in technical vocabulary raises Hit@1 from 0.214
to 0.321 and drops recall from 0.571 to 0.393 — a net wash.

```sh
git why "why do we retry twice before giving up"
git why "what was that bug with duplicate webhook deliveries"
git why "who built the TLS layer" --owners
git why "when was HTTP/3 support first introduced" --first
git why "when was HTTP/3 support added" --first
```

## Trusting results

It misses roughly seven hard questions in ten while still beating every
alternative on them. Verify with `git show <sha>` before acting. If nothing
looks relevant, report that the history does not record a reason rather than
assembling one from a weak match — a confident wrong "why" is worse than none.

## Reading an ordinal or owners answer

`--owners`, `--first`, `--last`, `--removed` and `--timeline` print their
answer **above** the ranked results, and it does not come from the ranking.
`--first` resolves from a lineage table, so on a large repository it routinely
names a commit that is not in the result list at all:

```
introduced: 3af0e76  HTTP3: initial (experimental) support  2019-07-21  (by http3)
```

Read the top line, not the list below it, and check the `(by <term>)`. An
ordinal resolved through the wrong term is wrong in a way the SHA does not
reveal. `--first` is the most reliable of the three; `--last` and `--removed`
often key on regenerated files where a term appears and disappears for reasons
unrelated to the feature.
