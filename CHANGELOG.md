# Changelog

## Unreleased

### Security

- Index locks: reclaiming a stale lock is serialised so it can no longer delete a
  live replacement; reader/lock tokens are written atomically so a reader is never
  pruned mid-write; tokens carry a PID-namespace id so a lock held from another
  container is not stolen; liveness checks no longer block the event loop.
- Jina (transformer) models are pinned to commit SHAs instead of `main`, honour
  `--offline`, use git-why's model cache and embed in micro-batches. Existing
  Jina indexes need a rebuild (the model fingerprint changed).
- Model downloads abort on a stall (60 s without bytes) instead of holding the
  download lock, and the lock is only reclaimed from a dead owner.
- Workflows: actions pinned by SHA, npm pinned for trusted publishing,
  `mcp-publisher` verified against its release checksum, the MCP registry step is
  idempotent on re-run, Dependabot auto-merge no longer covers runtime deps.

### Changed (daemon and MCP)

- The daemon no longer ignores `--offline` or `GIT_WHY_EMBEDDING`: both travel in the
  search request, and the daemon loads the model the client asked for.
- `instance.json` is written atomically and never deleted on a parse error; only one
  daemon can run (O_EXCL lock); `server off` refuses to signal a pid that does not look
  like a git-why daemon.
- MCP bridge: queries are passed as `--query=` (so `help`, `status` or `--flag-like`
  text is searched for), tool failures are `isError` results, `ping` and protocol
  negotiation work, malformed JSON gets a parse error, calls time out after 120 s
  (`GIT_WHY_MCP_TIMEOUT_MS`), and `cwd` must be inside the server's directory or
  `GIT_WHY_MCP_ROOTS`.

### Added

- `GIT_WHY_MODEL_BASE_URL` (mirror; hashes still enforced), `GIT_WHY_OFFLINE=1`,
  and `HTTPS_PROXY` support for model downloads.
- CI runs the network-free integration suite and the unit suite on the Node 22.12
  engines floor.

### Fixed

- `-- .` (the repository root) no longer matches nothing; brackets and braces are
  accepted in path restrictions (`app/[id]/page.tsx`); path keys with quotes match.
- Only a root-level `build/` or `out/` is treated as generated output, so
  `src/build/`, `cmd/build/` and similar source directories are indexed. (Existing
  indexes rebuild automatically: extraction policy version 2.)
- `--first` and the lineage index use tokens from the whole commit, not the 8 KB
  excerpt; `++i;` and `-- comment` lines are no longer dropped.
- Lexical, lineage, query and overlap tokenization are Unicode-aware (accents, CJK,
  Cyrillic); queries with no indexable token no longer reach the FTS engine.
- `--author="O'Brien"` matches; quotes of both kinds no longer produce an internal error.
- A commit whose extraction throws is kept message-only with an `extraction_error`
  reason instead of failing its batch on every refresh.
- Commits touching more than 4096 paths keep their directory keys, so directory
  restrictions still find them.
- Two non-UTF-8 paths with the same display string no longer overwrite each other's hunks.
- Capability probes ignore the caller's global git config, so snapshot fingerprints no
  longer vary by machine.
- Integration fixtures ignore the developer's global git config (CRLF, non-UTF-8
  paths) and the EPIPE test no longer overflows the 128 KiB env-string limit.

## 0.1.2

### Security

- Terminal output now strips bidirectional-override and zero-width characters
  from repository text (Trojan Source style spoofing of subjects and paths).
- A commit with an out-of-range timestamp no longer crashes human output.
- The cached model files are re-hashed on first use per process and model
  downloads have a timeout.
- `GIT_WHY_TEST_BACKEND` is honoured only when `NODE_ENV=test`.
- CI runs with read-only token permissions.

### Fixed

- Merge, lockfile, binary and size-clipped commits are no longer re-extracted
  and re-embedded on every refresh; only commits with material Git could not
  supply are retried.
- Indexing no longer rewrites the whole catalog and lineage files after every
  32-commit batch.
- `--before`, `--after`, `--around` and `--between` now change the ranking for
  date, tag and commit anchors, and warn when an anchor cannot be resolved.
  Words like "before" or "since" in a question no longer trim the query or
  switch on lineage expansion.
- A daemon that finds its index stale releases its shared lock, so the next
  direct query no longer waits 30 s and fails with `INDEX_BUSY`.
- An index built with a different embedding model is refused with
  `MODEL_MISMATCH`; `git why rebuild` keeps the recorded model unless
  `--use-default-model` is given. An index built by an older extraction policy
  is rebuilt into a new generation instead of being re-stamped.
- A corrupt `pending.json` is recovered by replaying the generation.
- Git subprocesses: unhandled stdin errors, orphaned children after a failed
  extraction, and a hung git are handled (15 minute timeout).
- The embedding model is disposed on every search path.

## 0.1.1

### Added

- `git why mcp` serves the MCP stdio bridge from the main executable, so MCP
  clients can run `npx -y @alliecatowo/git-why mcp`. `git-why-mcp` still works.
- MCP registry entry `io.github.alliecatowo/git-why` (`server.json`, `mcpName`),
  published from the release workflow with GitHub OIDC.

### Changed

- Documentation site restyled (Dracula and Alucard palettes, light and dark
  themes, no orange) and the hero tagline no longer shows literal backticks.
- The MCP server reports the real package version.

## 0.1.0

First release. There are no prior versions, so everything below is the initial
surface rather than a diff against one.

### Added

- `git why "<question>"` — hybrid semantic and full-text retrieval over commit
  messages and diff hunks, returning real commits with their evidence.
- `--owners` — who established an area, weighted by the relevance of their
  commits rather than by surviving lines (`git blame`) or commit count
  (`git shortlog`).
- Temporal queries — `--first`, `--last`, `--removed`, `--timeline`,
  `--before/--after/--between/--around`. Ordinals resolve by commit ancestry,
  never by timestamp, because rebases and cherry-picks rewrite dates.
- `--group` with RRF fusion, `--sort`, path restrictions, `--json` with a
  versioned envelope, and a man page reachable through `git why --help`.
- Index lifecycle: `index` (with `--if-needed`), `status` (with
  `--check-ready` for scripts), `rebuild`, `gc`. One index per repository,
  shared by every worktree.
- MCP server (`git-why-mcp`) exposing `git_why_search` and `git_why_status`,
  and two Claude Code plugins: `git-why` alone, and `git-why-full` which pairs
  it with `zg` and adds a history-explorer agent. An `opencode/` config and
  `AGENTS.md` fragment for OpenCode.
- Shell completions for bash, zsh and fish via `git why completion <shell>`,
  completing both the `git why` and `git-why` spellings.
- Optional transformer embedders. `GIT_WHY_EMBEDDING=jina-v2-small` scores
  +41% MRR over the shipped static model and `jina-v2-base` +64%, at 191x and
  1287x the indexing time and an optional `@huggingface/transformers` runtime.
  The default is unchanged and needs no such runtime; ten models are compared
  in [`docs/embedding.md`](docs/embedding.md).
- An optional daemon: `git why server on|off|status`. Holds the index, the
  embedding model and the lineage table open between queries — 569 ms to
  286 ms on a 30,000-commit repository. `--daemon=direct|server|auto`
  (`GIT_WHY_MODE`); `auto` falls back to running directly whenever the daemon
  cannot help, so it can never be the reason a search fails.

### Measured

- On 174 questions derived from six real repositories and verified
  unanswerable by keyword search: MRR 0.266, Hit@5 0.374, against 0.026 for
  `zg` and 0.003 for `git log --grep`.
- `git log -S` beats this tool 0.950 to 0.350 on cross-file causal questions.
  The shipped skill says so, because a tool that oversells itself makes an
  agent worse at its job.
- Index at 5.51–7.84 KB per record across six real repositories. Warm query on
  curl (30,000 commits, 182,772 records): p50 807 ms, p95 1199 ms.
- Eight optimisations implemented and measured; one survived. Lexical overlap
  reranked over a deeper candidate pool gained +26% MRR on a held-out split.
  The other seven did not improve MRR and were rejected. See
  [`docs/decisions.md`](docs/decisions.md).
- Agent benchmark across several models, four arms, paired per task, with
  token counts reconciled against the provider's own accounting. See section 5
  of [`docs/report.md`](docs/report.md).

### Known limits

- It misses roughly three hard questions in five (Hit@5 0.374). Results are
  leads to verify with `git show`, not established fact.
- `--last` and `--removed` are weaker than `--first`, because regenerated files
  make a term appear and disappear for reasons unrelated to the feature.
- No Windows support; use WSL2.
