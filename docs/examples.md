# Examples

Every block below is real recorded output, taken from the asciinema casts in
`site/public/casts/` that `scripts/record-casts.mjs` produced by running these
exact commands against pinned public repositories. Long excerpts are trimmed
for width; nothing is edited for flattery, including the example where this is
the wrong tool.

## The question you cannot grep for

You remember a performance problem but not what fixed it, and you have no
identifier to search for.

```console
$ git why "why did making lots of schemas suddenly get slow and memory-hungry"

1. 3063993  perf(v4): cut per-schema memory ~90% by moving methods to the prototype (#6318)
   2026-08-13 · Chris Cook

   Schema instances carried their methods as own properties, which put them
   past the point where V8 stops using inline slots for property storage.
   Moving those methods to the prototype — where they mate…

   packages/bench/memory/dict-mode.ts
   +/**
   + * Reports whether schema instances and their `_zod` internals are in V8
   + * dictionary (slow) mode. A dictionary-mode object pays a NameDictionary
   + * backing store — roughly 900 B at these property counts — instead of
   + * inline slots, and every property read goes through a hash lookup.
```

`git log --grep` cannot find this: the question says "slow and memory-hungry"
and the commit says "cut per-schema memory by moving methods to the
prototype". They share one word. That mismatch is the whole reason the tool
exists.

## When NOT to use it

If you can see the identifier, use pickaxe search. It is measurably better —
Hit@10 0.950 against 0.350 — and it is exact rather than ranked.

```console
$ git log -S CompiledFn --oneline -3

213ee75d feat(compile): add z.withParser for externally generated parsers (#6575)
81ded991 perf: answer z.validate from the compiled fast path on invalid input (#6538)
9782f87c perf(v4): validate without building the output, and keep schemas out of dictionary mode (#6480)
```

Asked the same thing semantically, this tool returns something adjacent and
ranked instead:

```console
$ git why "the compiled fast path helper" -n 3

1. 5ff9566  Stop re-exporting the compile internals from zod/v4/core (#6511)
   2026-08-29 · Colin McDonnell
```

Related, but not the origin. `git log -S` had the answer first and exactly.
The skill shipped with the plugin says so explicitly, because the failure mode
of a new tool is people reaching for it when an old one is better.

## Who established an area

`git blame` credits whoever last touched a line, so a formatting sweep rewrites
history. `git shortlog` counts commits, so mechanical churn outranks design.

```console
$ git why "TLS backend abstraction and vtls layer" --owners -n 20

owners, by relevance of their commits:
   1. Daniel Stenberg <daniel@haxx.se>  49%  9 commits  2014-07-29..2022-01-27
      2218c3a  vtls: pass on the right SNI name
   2. Johannes Schindelin <johannes.schindelin@gmx.de>  23%  4 commits  2017-08-28
      d65e6cc  vtls: prepare the SSL backends for encapsulated private data
   3. Steve Holme <steve_holme@hotmail.com>  12%  2 commits  2013-12-26..2015-01-17
      f88f9be  vtls: Updated comments referencing sslgen.c and ssluse.c
```

The share is each author's summed rank score as a fraction of the total, not a
share of commits — it is what the ranking actually compared them on. The commit
count sits beside it because 49% off nine commits and 49% off ninety mean
different things, and one commit each is printed so you can check the claim
without running a second query.

Measured against the alternatives on curl: `--owners` agrees with `shortlog` on
the top author and differs in the tail; `blame` disagrees outright, because
surviving lines measure recency of editing rather than authorship of design.
Which is "right" depends on what you mean by owns, and nothing here settles it.

## When it was first introduced

```console
$ git why "when was HTTP/3 support first introduced" --first

introduced: 3af0e76  HTTP3: initial (experimental) support  2019-07-21  (by http3)

1. 011788f  msh3: fix the QUIC disconnect function
   2022-08-12 · Daniel Stenberg
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

## How something evolved

```console
$ git why "HTTP/2 multiplexing support" --timeline -n 5

timeline:
   2014-06-19  introduced  00d84a2  ROADMAP: initial commit of "curl the next few years"
   2014-11-20  modified    7d1f2ac  http: Disable pipelining for HTTP/2 and upgraded connections
   2015-05-18  modified    6e6b02f  http: switch on "pipelining" (multiplexing) for HTTP/2 servers
   2015-05-18  modified    02ec1ce  CURLMOPT_PIPELINE: bit 1 is for multiplexing
   2015-05-18  modified    8114437  CURLOPT_PIPEWAIT: added
```

A chronology of one thing, ordered by ancestry rather than by relevance. Note
the ROADMAP commits at the top: the timeline follows the lineage chain wherever
it leads, and on curl the earliest mentions of multiplexing are in a planning
document rather than in code.

## Checking whether a constraint expired

The highest-value use, and the one that is hardest to get from any other tool.

```console
$ git why "why do we avoid sending the expect 100-continue header" -n 3

1. a6206a3  Fixes to bring back the the "Expect: 100-continue" functionality. If the
   2003-02-24 · Daniel Stenberg

   header is used, we must wait for a 100-code (or timeout), before we send the
   data. The timeout is merely 1000 ms at this point. We may have reason to set
   a longer timeout in the future.

   lib/http.c
   -
   +    http->sending = HTTPSEND_BODY;
        /* the full buffer was sent, clean up and return */
```

"We may have reason to set a longer timeout in the future" is a constraint with
a date on it. A workaround outliving its reason is common, invisible in the
code, and recorded only in history — which is why the question is worth asking
before you delete something that looks pointless.

## Honest expectations

On hard questions — ones where `git log --grep` and `git log -S` both provably
fail — `git why` returns the right commit in the top five about 29% of the
time. That is roughly 18x the best Git-native alternative on those questions,
and it is wrong most of the time.

Treat a result as a lead: read it, confirm it with `git show`, and if nothing
looks relevant, say the history does not record a reason rather than building
an explanation out of a weak match.
