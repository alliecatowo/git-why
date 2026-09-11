---
name: Bad search result
about: git why returned something unhelpful, or missed something it should have found
labels: retrieval
---

**What you asked**

```
git why "..."
```

**What you expected to find**

The commit SHA if you know it, or a description.

**What came back**

Paste the top few results, or `--json` output if you have it.

**Repository shape**

Public repo and commit if it is one, otherwise: roughly how many commits, and
whether commit messages tend to be terse or detailed.

---

Worth knowing before you file: `git why` misses roughly seven in ten hard
questions, so a single miss is expected behaviour rather than a bug. What is
genuinely useful to report is a miss where `git log --grep` or `git log -S`
_would_ have found it — that is a case this tool should not be losing.
