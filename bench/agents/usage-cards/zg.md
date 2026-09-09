## Extra tool available: `zg` (Zvec-Grep)

`zg` searches the CURRENT workspace's source files by meaning, not just
literal text, to help locate where relevant behavior lives today.

```sh
zg search "retry logic for network errors"
zg search "token refresh" --path src/
```

NOT VERIFIED: `zg` is not installed in the harness-authoring environment, so
this card's exact flags are inferred from general Zvec-Grep CLI conventions
described in docs/spec.md, not from `zg --help` on an installed copy. Before
running any real B/C trial, regenerate this card from `zg --help` on the
actually-installed, pinned version, per docs/spec.md section 19 ("Verify
exact invocation syntax through installed help because the published CLI has
changed between releases"). Do not run B/C trials with an unverified card.
