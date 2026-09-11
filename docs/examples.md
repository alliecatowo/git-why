# Examples

Every command here was run against a real repository at a pinned commit. The
output is trimmed for width, not edited for flattery — including the example
where the tool is the wrong choice.

## The question you cannot grep for

You remember a performance problem but not what fixed it, and you have no
identifier to search for.

```console
$ git why "why did making lots of schemas suddenly get slow and memory-hungry"

1. perf(v4): cut per-schema memory ~90% by moving methods to the prototype
   3b9e1f2  2025-08-14  Colin McDonnell
   Schema instances carried their methods as own properties, which put
   them past the hidden-class limit and forced megamorphic lookups.
```

`git log --grep` cannot find this: the question and the commit share almost no
vocabulary. That mismatch is the whole reason the tool exists.

## When NOT to use it

If you can see the identifier, use pickaxe search. It is measurably better —
Hit@10 0.950 against 0.350 — and it is exact rather than ranked.

```console
$ git log -S CompiledFn --oneline
a41c9e0 perf: answer z.validate from the compiled fast path
```

`git why` has no advantage over a tool you can hand the literal to. The skill
shipped with this plugin says so explicitly, because the failure mode of a new
tool is people reaching for it when an old one is better.

## Who established an area

`git blame` credits whoever last touched a line, so a formatting sweep rewrites
history. `git shortlog` counts commits, so mechanical churn outranks design.

```console
$ git why "TLS backend abstraction and vtls layer" --owners

Daniel Stenberg        14 commits   weight 0.298
   vtls: pass on the right SNI name
Johannes Schindelin     4 commits   weight 0.092
   vtls: prepare the SSL backends for encapsulated private data
```

Measured against the alternatives on curl: `--owners` agrees with `shortlog` on
the top author and differs in the tail; `blame` disagrees outright, because
surviving lines measure recency of editing rather than authorship of design.
Which is "right" depends on what you mean by owns, and nothing here settles it.

## When it was first introduced

```console
$ git why "when was HTTP/3 support first introduced" --first

introduced: 3af0e76  HTTP3: initial (experimental) support  2019-07-21  (by http3)

1. 011788f  msh3: fix the QUIC disconnect function
   ...
```

Ordinals come from ancestry, never timestamps, because rebases and cherry-picks
rewrite commit dates on exactly the repositories where the question is worth
asking.

Note what the ranked results underneath are doing here: nothing useful. The
answer is resolved from the lineage table, not from the ranking, so on a
30,000-commit repository it routinely names a commit that ordinary retrieval
never surfaces — `3af0e76` is not in the top ten. `(by http3)` names the token
the interval was keyed on, which is what makes the claim checkable: an ordinal
resolved by the wrong token is wrong in a way the SHA alone will not show you.

## Checking whether a constraint expired

The highest-value use, and the one that is hardest to get from any other tool.

```console
$ git why "why do we buffer uploads instead of streaming"

1. Buffer uploads in memory instead of streaming
   We would prefer to stream straight to storage, but blobstore-sdk 1.x
   has no streaming write API - putObject only accepts a Buffer.
```

Then check whether that is still true. A workaround outliving its reason is
common, invisible in the code, and only recorded in history.

## Honest expectations

On hard questions — ones where `git log --grep` and `git log -S` both provably
fail — `git why` returns the right commit in the top five about 29% of the
time. That is roughly 18x the best Git-native alternative on those questions,
and it is wrong most of the time.

Treat every result as a lead to verify with `git show`, not as an answer. If
nothing looks relevant, the history probably does not record a reason, and
saying so is more useful than constructing one.

Full methodology and per-strategy numbers: [`report.md`](report.md).
