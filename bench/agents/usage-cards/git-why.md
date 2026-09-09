## Extra tool available: `git why`

`git why` searches this repository's commit history (messages and diffs) for
the change that explains a piece of behavior. It is read-only.

```sh
git why "duplicate websocket events after reconnect"
git why "retry behavior" -- src/network/
git why "token refresh" -n 20
git why "ReconnectManager" --text       # exact-name/keyword search only
git why "confusing behavior" --semantic # meaning-based search only
git why "refresh loop" --no-refresh     # required in this environment: the index is prebuilt and frozen
```

Notes:
- Default output shows up to 5 matching commits with subjects, dates, and relevant diff excerpts.
- `--` restricts to a file or directory path.
- This environment's history index is frozen; always pass `--no-refresh`.
- `git log`, `git show`, `git blame`, `git log -S`, and `git log -G` are also available, as always.
