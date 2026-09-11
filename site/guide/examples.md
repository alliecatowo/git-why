# Examples

Recorded sessions, not reconstructions. Every frame is a command actually
executing against a real public repository at a pinned commit: the timings are
real latency and the output is whatever the tool printed.

## A question with nothing to grep for

<Cast src="/casts/ask.cast" title='git why "why did making lots of schemas suddenly get slow and memory-hungry"' />

The question shares almost no vocabulary with the commit that answers it —
"slow and memory-hungry" against "moving methods to the prototype". Keyword
search cannot bridge that, which is the entire reason this exists.

## Is this workaround still needed?

<Cast src="/casts/expired-constraint.cast" title='git why "why do we avoid sending the expect 100-continue header"' />

The highest-value use, and the one with no good alternative. A comment can
state a constraint; only history can tell you **when** it was written and
whether it still holds. `grep` finds the workaround, `blame` finds who typed
it, neither dates the reason.

## Who established an area

<Cast src="/casts/owners.cast" title='git why "TLS backend abstraction and vtls layer" --owners -n 20' />

`git blame` credits whoever last touched a line, so a formatting sweep reassigns
authorship. `git shortlog` counts commits, so mechanical churn outranks design.
`--owners` weights commits by relevance instead.

Measured against both on curl: it agrees with `shortlog` on the top author and
differs in the tail; `blame` disagrees outright. Which is "right" depends on
what you mean by _owns_, and nothing here settles that.

## When something was first introduced

<Cast src="/casts/first.cast" title='git why "when was HTTP/3 support first introduced" --first' />

Watch what the ranked results are doing here: nothing useful. The answer line
comes from the lineage table, not from the ranking, so on a 30,000-commit
repository it names a commit ordinary retrieval never surfaces — `3af0e76` is
not in the top ten below it.

`(by http3)` names the token the interval was keyed on. That is what makes the
claim checkable: an ordinal resolved by the wrong token is wrong in a way the
SHA alone will not show you.

## How something evolved

<Cast src="/casts/timeline.cast" title='git why "HTTP/2 multiplexing support" --timeline' />

Ordinals resolve by **ancestry, not timestamps**, because rebases and
cherry-picks rewrite commit dates on exactly the repositories where the
question is worth asking.

## When NOT to use this

<Cast src="/casts/wrong-tool.cast" title="git log -S beats semantic search when you can name the symbol" />

If you can see `CompiledFn` in the code, `git log -S CompiledFn` finds its
history exactly and instantly. Semantic search returns something adjacent and
ranked. Measured on cross-file causal questions: **`git log -S` scores Hit@10
0.950 against this tool's 0.350.**

This is on the examples page deliberately. A demo reel that only shows wins
teaches people to reach for the wrong tool, and the agent skill shipped with
the plugin says the same thing.

## An agent choosing for itself

<Cast src="/casts/agent.cast" title="An agent asked why schema creation got slow" />

Given a neutral list of what exists — `git log`, `git show`, `git blame`,
`grep`, `rg`, `git why` — and **no instruction about which to use**, with
`gh`/`curl`/`wget` shadowed so the GitHub API was not an escape hatch.

It reached for history on its own, verified the result with `git show`, and
reported the measured numbers including the one axis that regressed.

Two earlier takes are worth knowing about: in the first, `gh` was reachable and
the agent answered from the GitHub API without touching the repository; in the
second, the prompt told it which tool to use, which only proves it follows
instructions. Only the third tests anything.

## Index management

<Cast src="/casts/index.cast" title="git why status; git why index --if-needed" />

`--if-needed` is idempotent: about 0.2s when the index is already current,
against minutes for a rebuild. Safe to run before any search.
