# The daemon

`git why` works with no daemon. Starting one makes queries about twice as fast
and costs you a background process.

```sh
git why server on       # start it
git why server status   # is it running?
git why server off      # stop it
```

Searches use it automatically once it is running. Nothing else changes.

## What it is for

A query without a daemon opens the index, loads the embedding model and reads
the lineage table, answers, and throws all three away. The next query does it
again. Measured on curl — 30,000 commits, 182,772 records:

|                     |    p50 |    p95 |
| ------------------- | -----: | -----: |
| no daemon           | 569 ms | 597 ms |
| `git why server on` | 286 ms | 301 ms |

The daemon holds exactly those three things open, per repository, and one
embedding model for the whole machine rather than one per repository.

It does **not** cache the refs snapshot. That is ~16 ms to capture and it is
the one thing that goes stale the moment you fetch, so it is recomputed on
every request and used to check that the warm handles still describe your
repository. If they do not, the daemon declines and your query runs directly.

## It can never be why a search fails

This is the property that makes it safe to leave on by default.

`--daemon=auto`, the default, falls back to running directly whenever the
daemon cannot help: none running, unreachable, killed without cleaning up,
pointing at a dead port, a protocol version from a different install, or
declining because your index moved. In every one of those cases you get an
answer, from the same code path you would have used anyway.

```sh
git why "..." --daemon=direct   # never contact it
git why "..." --daemon=server   # require it; fail if it is not there
git why "..." --daemon=auto     # default
```

`--daemon=server` exists for scripts that want to be told rather than silently
fall back to the slow path. `GIT_WHY_MODE` sets the default for a shell.

Output is identical either way. Thirteen query shapes — plain, `--text`,
`--semantic`, each ordinal, `--timeline`, `--owners`, `--group`, `--sort`, a
path restriction and an anchored temporal query — produce byte-identical JSON
direct and through the daemon, and that is checked rather than assumed.

## What it holds, and for how long

One process serves every repository on the machine. Each repository's handles
are released after 15 minutes idle; the embedding model is shared and stays.
Handles are reference-counted, so an idle sweep never closes a collection out
from under a query that is still running.

```console
$ git why server status
server: ready
pid:    64172
url:    http://127.0.0.1:63856
version: 0.1.0
uptime: 66s
open:   1 repository
served: 76
```

## Security

- **Loopback only.** It binds `127.0.0.1` and is never exposed on a routable
  interface.
- **Bearer token**, generated per daemon, written to the instance record with
  mode 0600. So "can you read that file" is the authorisation check — and that
  is the same question as "can you read the index", which any local process
  running as you could already answer. The daemon grants nothing that was not
  already available; it only makes it faster.
- **Read-only.** It serves searches and status. It never indexes, rebuilds,
  compacts or writes to a repository. Anything that takes an exclusive lock
  runs in your own process, where you can see it.
- **It holds shared locks** on the indexes it has open, which is why `off`
  exists and why handles are released on idle.

## When it is not running

Every `git why` invocation works. That is the whole design: the daemon is an
accelerator, not a dependency. There is no watcher, no hook, nothing started
on your behalf, and nothing that survives `git why server off`.

A record left behind by a daemon that was killed is detected by signalling the
recorded PID and removed, so a crash costs you one process and nothing else.
