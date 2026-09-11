---
name: codebase-archaeology
description: Use when investigating an unfamiliar codebase - understanding why something is built the way it is, finding where a concept lives, checking whether an approach was tried before, or deciding whether a workaround is still needed. Routes between zg (current code) and git why (history) and plain git, which answer different questions and are not interchangeable.
---

# Investigating a codebase you did not write

Three tools, three different questions. Picking the wrong one is the common
failure, and the boundaries below are measured rather than guessed — from 174
questions derived from six real repositories, plus a cross-file corpus where
the answer is deliberately in a different file than the question.

## The routing rule

| you want to know                  | tool                 | why                                                                  |
| --------------------------------- | -------------------- | -------------------------------------------------------------------- |
| where something **is**, right now | `zg`                 | searches the working tree                                            |
| **why** it is that way            | `git why`            | searches history; ~23x `git log --grep` on questions you cannot grep |
| what touched a **known symbol**   | `git log -S<symbol>` | 0.950 vs 0.350 — beats semantic search when you have the literal     |
| history of one **file**           | `git log -- <path>`  | exact, cheap, blind to other files                                   |
| who wrote a **line**              | `git blame`          | line-level, and biased toward whoever last reformatted               |

Two mistakes worth naming because they are the ones actually made:

**Reaching for semantic search when you have an identifier.** If you can see
`CompiledFn` in the code, `git log -S CompiledFn` finds its origin far more
reliably than describing it. Newer is not better here.

**Reaching for code search to answer a "why".** `zg` searches the code that
exists. A reverted approach, an abandoned design, the reason a workaround was
added — none of that is in the working tree. It is only in history.

## A working order

1. **`zg`** to find where the concept lives. You usually do not know the path.
2. **Read the code.** Now you have real identifiers.
3. **`git log -S<identifier>`** if you want what introduced a specific thing.
4. **`git why "<question in plain words>"`** if you want the reasoning, an
   incident, a prior attempt, or an expired constraint.
5. **`git show <sha>`** on anything before you rely on it.

Combining `zg` and `git why` on the same question measurably did NOT beat
either alone — they are for different steps, not for redundancy. Use each where
it fits in the sequence above.

## Asking git why well

Plain, vague phrasing works better than technical phrasing. That is
counter-intuitive and measured: restating a question in technical vocabulary
raises Hit@1 from 0.214 to 0.321 but drops recall from 0.571 to 0.393 — a net
wash, so ask the way you would ask a person.

```
git why "why do we retry twice before giving up"
git why "what was that bug with duplicate webhook deliveries"
git why "why is this cache keyed on tenant as well as id"
git why "who built the TLS layer" --owners
git why "when was HTTP/3 support added" --first
```

Describe a **symptom or a decision**. Do not describe a file — `git log --
<path>` already does that better.

## Before you change something

The highest-value moment to ask is before you remove or replace code that looks
wrong. Three questions worth one search each:

- **Does this guard/workaround have a reason?** Code that looks pointless is
  often load-bearing for a reason recorded only in a commit message.
- **Was the obvious approach already tried?** If what is there is not obvious,
  someone may have tried the obvious thing and reverted it. The revert message
  usually says why.
- **Does the original reason still hold?** "We buffer because the SDK has no
  streaming API" stops being true when the SDK gains one. History dates the
  constraint; the code does not.

## Trusting the answer

`git why` misses roughly three hard questions in five. It is still far better
than the alternatives on those questions, and both facts matter: treat a result
as a strong lead, verify it with `git show`, and if nothing looks relevant say
the history does not record a reason rather than assembling one from a weak
match. A confident wrong "why" is worse than no answer.
