# The Claude Code plugin

Ships the MCP server, a skill that teaches an agent when to reach for history,
and an agent definition for deeper investigation.

## Install

```bash
npm install -g @alliecatowo/git-why
```

Two plugins ship:

- **`plugins/git-why`** — the tool alone: MCP server, the history skill, and
  index management.
- **`plugins/git-why-full`** — adds `zg` for current-code search, a routing
  skill that covers both, and the `history-explorer` agent.

Add either directory to Claude Code. The MCP server is registered by
`plugin/.mcp.json` and runs the `git-why-mcp` binary that the npm package
installs, so no separate server setup is needed.

## What it contains

**`skills/history-archaeology`** — the routing rules, written from measurement
rather than intuition. It tells an agent to use `git why` when it cannot name
the term it is looking for, and to use `git log -S` when it can, because the
second case is one `git why` measurably loses (Hit@10 0.950 against 0.350). A
skill that claimed the tool is always best would make an agent worse at its
job.

It also tells the agent that natural, vague phrasing works better than
technical phrasing. That is counter-intuitive and is the kind of thing a model
gets wrong by default: restating a question in technical vocabulary raises
Hit@1 but costs more recall than it gains.

**`agents/history-explorer`** — for questions that need several searches and
cross-checking rather than one lookup. It is told to follow reverts (a
reverted commit usually explains itself better than one that stuck), to check
whether constraints still hold, and to distinguish what history _states_ from
what it _shows_ from what the agent _infers_.

**`.mcp.json`** — registers the `git-why` MCP server.

## Why there is no hook

A hook that ran history searches automatically would spend tokens on every
edit for a question nobody asked. The measured hit rate on hard questions is
about 29% in the top five, which is strong relative to the alternatives and
not strong enough to justify unsolicited calls. The skill guides the agent to
ask when it is worth asking; that is the right granularity.

## Verifying it works

```bash
git why index                  # build the index for the repo
git why status --check-ready   # exit 0 when current
git why "why do we retry twice"
```

If the agent has the skill loaded it should reach for `git why` on "why is
this like this" questions and for `git log -S` when it already has an
identifier. If it reaches for `git why` with a symbol it can already see, the
skill is not doing its job — that is the specific failure worth reporting.

## OpenCode

`opencode/` holds an `AGENTS.md` fragment and an `opencode.json` with the MCP
registration. Copy the guidance into your project's `AGENTS.md` or point your
config at the JSON.

## Shell completions

```sh
git why completion zsh  > ~/.zsh/completions/_git-why
git why completion bash > /usr/local/etc/bash_completion.d/git-why
git why completion fish > ~/.config/fish/completions/git-why.fish
```

The scripts complete `git why ...` as well as `git-why ...`, since Git
dispatches the subcommand form and that is how people actually type it.
