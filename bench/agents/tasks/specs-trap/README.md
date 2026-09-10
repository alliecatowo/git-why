# Trap tasks: does history knowledge prevent a costly mistake?

The earlier task sets measured the wrong thing. They asked "when was X
introduced", which is answerable by finding the right file and running
`git log` on it. `zg` finds the file, plain Git does the rest, so a
general code-search tool won its own history benchmark without performing
any history reasoning. Measured: zg 77%, git why 50%, both together 42%.

These tasks are built around one property, and it is the whole point:

**the decisive evidence exists ONLY in history, never in the working tree.**

Each task contains an approach that was tried, caused a specific failure, and
was reverted. Because it was reverted, the code is gone. `zg`, `grep` and
reading the repository cannot find it -- there is nothing there to find. It
survives only in commit messages and reverted diffs, which is exactly the
material Git Why indexes and nothing else does.

Two shapes, both drawn from what the tool is actually for:

1. **repeat-the-mistake.** History shows approach X was tried and caused
   failure Z, then reverted. The agent is asked for a feature where X is the
   obvious approach. Does it avoid X, or walk into the same wall?

2. **stale-constraint.** History shows the code does Z _because_ Y did not
   exist at the time. Y exists now. The agent is asked to improve that area.
   Does it notice the original constraint no longer applies and propose the
   better approach, or preserve a workaround nobody needs?

Grading is behavioural, not citational: what did the agent DO. Citing the
commit is recorded separately as evidence of how it got there.

A control condition is mandatory. Each trap task ships with a twin whose
history contains no warning, where X is genuinely the right answer. An agent
that has learned "avoid whatever the benchmark hints at" fails the control.
Without it, a high trap score cannot be distinguished from blanket caution.
