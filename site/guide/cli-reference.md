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

| Flag                   | Meaning                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| `-n <1-50>`            | Distinct commits to return. Default 5, max 50.                                                                 |
| `-- <path>...`         | Restrict to literal historical paths; a trailing `/` means a directory prefix.                                 |
| `--after=<date>`       | Only commits at or after this date (UTC, ISO-8601).                                                            |
| `--before=<date>`      | Only commits strictly before this date (UTC, ISO-8601).                                                        |
| `--author=<substring>` | Case-insensitive substring of author name or email.                                                            |
| `--text`               | Full-text search only.                                                                                         |
| `--semantic`           | Vector search only (default is hybrid).                                                                        |
| `--sort=<order>`       | `relevance` (default), `oldest`, or `newest`. Reorders the selected commits; never changes which are returned. |
| `--json`               | Emit the versioned JSON envelope on stdout.                                                                    |
| `--no-refresh`         | Never create, mutate, or repair the index; requires one to exist.                                              |
| `--offline`            | Also forbid model downloads.                                                                                   |
| `--max-bytes=<n>`      | Bound rendered output, including JSON framing (default 16384, max 262144).                                     |
| `--lock-timeout=<sec>` | Seconds to wait for another process (default 30).                                                              |
| `--query <text>`       | Explicit query text, for text that looks like a command or option.                                             |
| `-h`                   | Show help (via `git why -h`; see note below).                                                                  |
| `--help`               | Show help when calling the `git-why` binary directly.                                                          |
| `--version`            | Show the version.                                                                                              |

Default mode is **hybrid** (both `--text` and `--semantic` branches, fused
with RRF); passing either flag runs a single branch instead.

`--sort` only reorders the commits retrieval already selected — asking
`--sort=oldest` cannot surface a commit that ranked below the `-n` cutoff.
For "when was this first introduced?" questions, widen the pool first
(e.g. `-n 20 --sort=oldest`). See
[Ordering results](/guide/operations#ordering-results).

## Lifecycle commands

| Command                               | Effect                                                 |
| ------------------------------------- | ------------------------------------------------------ |
| `git why index`                       | Create or reconcile the index.                         |
| `git why status`                      | Report index state without mutating anything.          |
| `git why status --json`               | Same, machine-readable.                                |
| `git why rebuild`                     | Replace derived index data.                            |
| `git why rebuild --use-default-model` | Rebuild, forcing the default embedding model.          |
| `git why gc`                          | Reconcile and compact, without downloading embeddings. |

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
