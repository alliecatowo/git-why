---
name: Bug report
about: A crash, a wrong exit code, corrupted index, or anything that is not a ranking question
labels: bug
---

**What happened**

**What you ran**

```
git why ...
```

**Output**

Include stderr. If it exited nonzero, include the code — they are documented in
[`docs/operations.md`](../../docs/operations.md).

**Environment**

- `git why --version`
- `git --version`
- `node --version`
- OS

**Index state**

Output of `git why status --json` if the repository still reproduces it.
