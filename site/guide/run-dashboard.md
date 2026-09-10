---
outline: false
---

# Run dashboard

<BenchDashboard />

This is a live view of the published benchmark state, refreshing every five
seconds. It separates attempted, valid, invalidated, and successful trials so
an incomplete run is never presented as an outcome. Use the treatment table to
compare arms, then inspect individual attempts for their redacted transcript,
final answer, stderr, tool calls, evidence use, and invalidation reason.

When running the docs locally, start Vite with
`BENCH_DASHBOARD_CONTROL=1 npm run dev`. The Start, Stop, and Resume buttons
then control only a smoke run launched by that Vite process. They never start
a pilot automatically; use the recorded terminal command for a pilot after its
protocol and budget have been approved. Published/static copies are read-only.

The status publisher may add these optional fields to `bench-status.json`:

- `agent.aggregates`: one row per arm, including valid/attempted/successful,
  pass rate, time, tokens, tool adoption, and evidence use.
- `agent.trials`: redacted per-trial records. The inspector displays
  `transcript`, `finalAnswer`, or `stderr` when one has been intentionally
  published.
- `agent.invalidations`: attempts retained for audit but excluded from arm
  aggregates.
