## Extra tool available: `zg` (Zvec-Grep)

`zg` searches the current workspace's source files by meaning, not just
literal text, to help locate relevant behavior today. The runner builds the
workspace index before this trial and verifies `zg status --check-ready`.

```sh
zg query "retry logic for network errors"
zg query --fts "AuthService"
zg query --hybrid "retry logic" --fts "retry" --fuse
```

Use `zg query --help` for the complete installed interface. The pinned CLI is
Zvec-Grep 0.2.2; this card is generated from that installed CLI's help.
