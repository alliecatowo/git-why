---
name: history-archaeology
description: Use when you need to know WHY code is the way it is - the rationale behind a design, whether an approach was already tried and abandoned, what a past incident was, or who established an area. Use when you cannot name the exact symbol or string to grep for. Do NOT use when you already know the identifier - `git log -S` is measurably better for that.
---

# Finding out why the code is like this

`git blame` tells you **who** touched a line. `git log -S` tells you **which
commits touched a string**. Neither tells you **why** anything was done, and
neither helps when you cannot name the thing you are looking for.

That gap is what `git why` is for, and its boundaries are measured rather than
claimed. The numbers below come from 174 questions derived from six real
repositories (curl, redis, requests, ripgrep, caddy, zod), each one verified to
be unanswerable by `git log --grep` or `git log -S`.

## Which tool, and why

**Reach for `git why` when you cannot name the term.**

On questions where keyword search provably fails, `git why` scores MRR 0.203
against 0.026 for `zg` and 0.003 for `git log --grep`. `git log --grep
--all-match` returns _nothing at all_ on 109 of 174. That is the regime it
exists for.

**Reach for `git log -S<symbol>` when you can name the term.**

Once you have the identifier in front of you, pickaxe search wins decisively:
Hit@10 0.950 against `git why`'s 0.350 on cross-file causal questions. If you
are reading code and can see the symbol, use `git log -S`. Do not reach for
semantic search because it is newer.

**Reach for `zg` for the current state of the code.** It searches the working
tree. `git why` searches history. They answer different questions and combining
them measurably did not beat either alone.

## When to use this proactively

Before writing code in an unfamiliar area, ask history one question. The cases
where it pays:

- **Something looks wrong or redundant.** A guard clause with no obvious
  trigger, a workaround for a bug you cannot reproduce, a constant that should
  be configurable. Ask before you remove it. Code that looks pointless is often
  load-bearing for a reason nobody wrote down in the file.
- **You are about to do the obvious thing.** If the obvious approach is not
  what is there, someone may have tried it. Ask whether it was.
- **A constraint may have expired.** Comments and workarounds describe the
  world when they were written. "We buffer because the SDK has no streaming
  API" stops being true when the SDK gains one. History tells you when the
  reason was recorded; the code does not.
- **You need to know who to ask.** `--owners` reports who established an area
  by the relevance of their commits, rather than who last reformatted it
  (`git blame`) or who committed most often (`git shortlog`).

## How to ask

Ask the way you would ask a colleague who was there. Natural, vague phrasing
works **better** than technical phrasing, which is worth stating because the
instinct is the opposite. Measured on the same cases, restating the question in
technical vocabulary raised Hit@1 from 0.214 to 0.321 but dropped recall from
0.571 to 0.393 — it finds the right thing more sharply when it finds anything,
and misses more often. Overall it is a wash, so do not bother.

```
git why "why do we retry twice before giving up"
git why "what was that bug with duplicate webhook deliveries"
git why "why is the session cache keyed on tenant"
git why "who built the TLS layer" --owners
```

Good questions describe a **symptom or a decision**. Poor ones describe a
**file**: `git log -- path/to/file` already does that, and does it better.

## Reading the answer

Every result is a real commit. Verify with `git show <sha>` before you act on
it — the tool ranks by relevance, and relevance is not proof. A high rank
means "most related thing in this history", not "this is definitely why".

`git why` is wrong roughly seven times in ten on hard questions. It is still
far better than the alternatives on those questions, and both halves matter:
treat its output as a strong lead to verify, never as an established fact.

If nothing returned looks relevant, say so and fall back to `git log -S` or
reading the code. Do not construct a rationale out of a weak match — an
invented "why" is worse than admitting the history does not say.

## Commands

```
git why "<question>"              search history
git why "<question>" --owners     who established this area
git why "<question>" --first      when it was first introduced
git why "<question>" --timeline   how it changed over time
git why index --if-needed         build or refresh; cheap, safe to run always
git why status --check-ready      is the index current
```

`--owners`, `--first`, `--last`, `--removed` and `--timeline` print their
answer **above** the ranked results, and that answer does not come from the
ranking. `--first` in particular resolves from a lineage table, so it
routinely names a commit that is not in the result list at all — read the line
at the top, not the list below it:

```
introduced: 3af0e76  HTTP3: initial (experimental) support  2019-07-21  (by http3)
```

`(by http3)` is the term the answer was keyed on, and it is worth checking. An
ordinal resolved through the wrong term is wrong in a way the SHA will not show
you. `--first` is the most reliable of the three: `--last` and `--removed` are
often keyed on regenerated files like RELEASE-NOTES, where a term appears and
disappears for reasons unrelated to the feature.

The index builds at roughly 5.9 KB per record and answers in under half a
second on a 30,000-commit repository, so it is cheap to keep current.
