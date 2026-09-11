# Contributing

See [`docs/contributing.md`](docs/contributing.md) for the full guide. The
short version:

```sh
mise run setup
mise run check              # format, lint, typecheck, protocol hash, unit tests
npm run test:integration
```

## The one rule that matters

**Never hand-edit a number in `README.md` or `docs/report.md`.** Both are
written by `bench/report.mjs` from raw run data — the README between
`<!-- generated:... -->` markers — and CI runs `node bench/report.mjs --check`
on the README, so an edited number there fails the build. (`docs/report.md` is
not byte-checked: it records the machine and moment it was generated on, so two
correct runs differ. Regenerate it rather than editing it.) If a number looks
wrong, fix the measurement or the generator, not the text.

This is not pedantry. Across this project's development, eight separate times
a plausible-looking number turned out to come from a broken denominator — runs
that scored zero cases and exited 0, audits that invalidated their own trials,
comparisons across different subsets. Every one of them looked publishable.
`docs/decisions.md` records them.

## If you are changing retrieval

Run the corpus benchmark before and after:

```sh
npm run bench:corpus
```

It needs no model and costs nothing, so there is no excuse for changing
ranking without it. A change that improves MRR on the 174-case corpus is worth
having; one that does not is worth reporting as a negative result in
`docs/decisions.md` rather than discarding. Seven optimisations are recorded
there precisely because knowing what does not work has value.
