# Changelog

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

### Measured

- On 174 questions derived from six real repositories and verified
  unanswerable by keyword search: MRR 0.203, against 0.026 for `zg` and 0.003
  for `git log --grep`.
- `git log -S` beats this tool 0.950 to 0.350 on cross-file causal questions.
  The shipped skill says so, because a tool that oversells itself makes an
  agent worse at its job.
- Index at 5.50–6.98 KB per record across 56,781 commits. Warm query on curl
  (30,000 commits, 182,772 records): p50 807 ms, p95 1199 ms.
- Seven optimisations implemented, measured, and rejected. See
  [`docs/decisions.md`](docs/decisions.md).
- Agent benchmark across several models, four arms, paired per task, with
  token counts reconciled against the provider's own accounting. See section 5
  of [`docs/report.md`](docs/report.md).

### Known limits

- It misses roughly seven hard questions in ten (Hit@5 0.287). Results are
  leads to verify with `git show`, not established fact.
- `--last` and `--removed` are weaker than `--first`, because regenerated files
  make a term appear and disappear for reasons unrelated to the feature.
- No Windows support; use WSL2.
