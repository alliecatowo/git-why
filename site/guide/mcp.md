# Agents and MCP

Git Why ships a [Model Context Protocol](https://modelcontextprotocol.io) server so an agent can search history the same way you do. It is a thin bridge onto the CLI's `--json` contract, not a second implementation: a search through MCP returns the same versioned envelope as `git why --json`.

## Run the server

Any MCP client that can launch a stdio server can use one of these commands:

```sh
npx -y @alliecatowo/git-why mcp     # no install needed
git why mcp                         # once git-why is installed
git-why-mcp                         # the dedicated binary the plugins use
```

The server is also listed in the MCP registry as `io.github.alliecatowo/git-why`.

## Claude Code

Register the server directly:

```sh
claude mcp add git-why -- npx -y @alliecatowo/git-why mcp
```

Or use a plugin from the repository's `plugins/` directory (install the package first with `npm install -g @alliecatowo/git-why`, since the plugins launch `git-why-mcp`):

| Plugin         | What you get                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------------- |
| `git-why`      | The MCP server, a routing skill (`history-archaeology`) and an index-management skill.                          |
| `git-why-full` | The same, plus [`zg`](https://zvec.org) for current-code search and a `history-explorer` agent for deeper digs. |

## Other clients

Any client that takes a command and arguments works. The generic shape:

```json
{
  "mcpServers": {
    "git-why": { "command": "git-why-mcp", "args": [], "env": {} }
  }
}
```

OpenCode uses its own schema; the repository's `opencode/opencode.json` is:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "git-why": { "type": "local", "command": ["git-why-mcp"], "enabled": true }
  }
}
```

## The tools

| Tool             | What it does                                                                                                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git_why_search` | The query. Takes `query`, `limit`, `sort`, `mode`, `groups`, `owners`, `cwd` and a `temporal` object (`first`, `last`, `removed`, `timeline`, `before`, `after`, `around`, `between`). |
| `git_why_status` | Whether the index exists and is current. Its description gives the agent the fix (`git why index --if-needed`) instead of only a state.                                                |

## Scope and safety

- A tool call may only operate inside the directory the server was launched for. Set `GIT_WHY_MCP_ROOTS` (a path-delimiter separated list) to allow more, or `*` to lift the restriction. Without this limit any caller could make Git Why create an index inside any repository on the machine.
- Each call has a 120 second timeout; override it with `GIT_WHY_MCP_TIMEOUT_MS`.
- The first search in a repository builds the index and downloads the model once. Run `git why index` ahead of time to keep that out of an agent's first turn.
- The server uses the [daemon](/guide/daemon) automatically when it is running.

## Verify it

```sh
git why index                    # build the index for the repo
git why status --check-ready     # exit 0 when it can answer now
git why "why do we retry twice"  # the same search the agent will run
```

## What to tell the agent

The shipped skill makes one point worth repeating, because it is measured: when the agent can name the symbol, `git log -S` beats this tool (Hit@10 0.950 against 0.350). Git Why is for the case where you remember what happened but not what it was called. There is deliberately no hook that searches history unprompted: at a top-five hit rate near 37% on hard questions, unsolicited calls would cost more than they return.
