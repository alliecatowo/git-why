Something is misconfigured in src/config.cjs: staging should terminate TLS
on port 8443 (see ops/runbook.md), but a request to the staging URL is
failing to connect in practice. Find and fix the bug.
