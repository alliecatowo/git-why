# Security

## Reporting a vulnerability

Open a [security advisory](https://github.com/alliecatowo/git-why/security/advisories/new)
rather than a public issue. Include what you did, what happened, and the
repository shape that triggered it if it matters.

## What this tool touches

Git Why reads a repository's history and writes an index under `.git/why/`.
It does not write to your working tree, does not modify history, and makes no
network calls at query time. The only network access is downloading the
embedding model on first use, from a pinned revision with a recorded file
hash — a newer upstream revision cannot silently substitute itself.

## Untrusted history is data, not instructions

Commit messages and diffs from a repository you did not write are untrusted
input. Git Why returns them verbatim as evidence; it never executes them and
never treats text found in history as instructions.

If you pipe results to a model, the same rule applies at your layer: a commit
message can contain anything, including text shaped like a prompt. The MCP
server and the shipped skill present results as quoted evidence for exactly
this reason.

## Index contents

The index contains commit messages and diff excerpts from your repository, so
it is as sensitive as the repository is. It lives inside `.git/`, is not
committed, and is removed with the repository. `git why gc` compacts it;
deleting `.git/why/` removes it entirely.
