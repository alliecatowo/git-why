# CLI reference

```text
Usage: git why <query> [-- <path>...] [options]
       git why --query <query> [options]
       git why index|status|rebuild|gc [options]
```

Use `git why -h` for this from the terminal — see the note on
[`--help`](/guide/getting-started#a-note-on-help) for why `git why --help`
does not reach the tool.

## Options

<!-- generated:options -->

| Flag                       | Meaning                                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-n <count>`               | Number of distinct commits to return (default 5, max 50)                                                                                                            |
| `--text`                   | Full-text search only                                                                                                                                               |
| `--semantic`               | Vector search only (default is hybrid)                                                                                                                              |
| `--sort=<order>`           | relevance (default), oldest, or newest. Reorders the selected commits; never changes which are returned                                                             |
| `--first --last --removed` | Resolve/order an introduction, last change, or removal                                                                                                              |
| `--timeline`               | Return the history-oriented retrieval view                                                                                                                          |
| `--before=<anchor>`        | Temporal anchor when non-ISO (tags, SHA, or a query); ISO dates remain history filters                                                                              |
| `--after=<anchor>`         | Temporal anchor when non-ISO (tags, SHA, or a query)                                                                                                                |
| `--between=<a>,<b>`        | Prefer commits between two temporal anchors                                                                                                                         |
| `--around=<anchor>`        | Prefer commits near a date, tag, or SHA                                                                                                                             |
| `--owners`                 | Who established this area, ranked by relevance of their commits rather than by surviving lines or commit count                                                      |
| `--group <query>`          | Additional retrieval group; fuse groups at commit level                                                                                                             |
| `--after=<date>`           | Only commits at or after this date (UTC, ISO-8601)                                                                                                                  |
| `--before=<date>`          | Only commits strictly before this date (UTC, ISO-8601)                                                                                                              |
| `--author=<substring>`     | Case-insensitive substring of author name or email                                                                                                                  |
| `--json`                   | Emit the versioned JSON envelope on stdout                                                                                                                          |
| `--refresh=<mode>`         | off: never create, mutate, or repair the index; requires one to exist. wait: refresh normally (the default); spelled out for scripts that want to say so explicitly |
| `--no-refresh`             | Alias for --refresh=off                                                                                                                                             |
| `--offline`                | Also forbid model downloads                                                                                                                                         |
| `--max-bytes=<n>`          | Bound rendered output, including JSON framing (default 16384)                                                                                                       |
| `--lock-timeout=<sec>`     | Seconds to wait for another process (default 30)                                                                                                                    |
| `--verbose`                | Also report model loading and download progress on stderr                                                                                                           |
| `--query <text>`           | Explicit query text, for text that looks like a command or option                                                                                                   |
| `--help`                   | Show this help                                                                                                                                                      |
| `--version`                | Show the version                                                                                                                                                    |

<!-- /generated:options -->

Flags below that apply to a subcommand rather than to a query:

<!-- generated:command-options -->

| Flag                  | Meaning                                                                                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--if-needed`         | With index: exit 0 immediately if the index is already current, so it is cheap to run unconditionally                                                           |
| `--check-ready`       | With status: exit non-zero unless the index exists, is current for the repository's refs, and covers every reachable commit. For scripts that gate on readiness |
| `--use-default-model` | With rebuild: re-embed with the default model rather than the one recorded in the existing index                                                                |

<!-- /generated:command-options -->

These two tables are generated from `git why -h` by
`site/scripts/gen-cli-reference.mjs`, and CI fails if they drift. The
hand-maintained version of this page documented fourteen flags while the tool
had twenty-six.

Default mode is **hybrid** (both `--text` and `--semantic` branches, fused
with RRF); passing either flag runs a single branch instead.

`--sort` only reorders the commits retrieval already selected — asking
`--sort=oldest` cannot surface a commit that ranked below the `-n` cutoff.
For "when was this first introduced?" questions, widen the pool first
(e.g. `-n 20 --sort=oldest`). See
[Ordering results](/guide/operations#ordering-results).

## Lifecycle commands

| Command                 | Effect                                                 |
| ----------------------- | ------------------------------------------------------ |
| `git why index`         | Create or reconcile the index.                         |
| `git why status`        | Report index state without mutating anything.          |
| `git why status --json` | Same, machine-readable.                                |
| `git why rebuild`       | Replace derived index data.                            |
| `git why gc`            | Reconcile and compact, without downloading embeddings. |

## Exit codes

| Exit  | Meaning                                                     |
| ----- | ----------------------------------------------------------- |
| `0`   | Successful command, including zero results                  |
| `2`   | Invalid invocation                                          |
| `3`   | No usable Git repository                                    |
| `4`   | Index, model, storage, compatibility, or extraction failure |
| `5`   | Index lock wait exceeded (see `--lock-timeout`)             |
| `130` | User interruption                                           |

Exit `4` is intentionally broad; with `--json` the machine-readable error
code distinguishes the cause. The full set is `GitWhyErrorCode` in
`src/types.ts`.

## JSON output

With `--json`, stdout carries exactly one valid JSON object and everything
else (progress, diagnostics) goes to stderr. `--max-bytes` clipping is
reported explicitly in the envelope and can never produce invalid JSON.

## Output safety

Every repository-sourced string — subject, body, author, path, diff line — is
sanitized of terminal control sequences before human rendering. A commit
message is untrusted input. `NO_COLOR`, terminal capability, and whether
stdout is a TTY are all respected; Git Why never launches a pager.

For the full operational contract (durability, concurrency, freshness,
history scope), see [Operations & guarantees](/guide/operations).
