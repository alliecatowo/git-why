# Changelog

## Unreleased

First public state. Prior to this the project had no released versions, so
everything below is the initial surface rather than a diff against one.

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
- MCP server (`git-why-mcp`) and a Claude Code plugin with a skill and an
  investigation agent.
- `git why status --check-ready` for scripts and benchmark harnesses.

### Measured

- On 174 questions derived from six real repositories and verified
  unanswerable by keyword search: MRR 0.203, against 0.026 for `zg` and 0.003
  for `git log --grep`.
- Index at 5.50–6.98 KB per record across 56,781 commits; warm query p50/p95
  483/494 ms.
- Seven optimisations implemented, measured, and rejected. See
  [`docs/decisions.md`](docs/decisions.md).
