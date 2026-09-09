# Working agreements

The full product specification is `docs/spec.md`. Read only the sections that
govern your lane; it is long.

## Shared contracts

`src/types.ts` is the only module every lane depends on. It defines records,
search results, the storage boundary, coverage, errors and exit codes. It
imports nothing from `src/`.

If you need a change to `src/types.ts`, do not make it silently — it breaks
every other lane. Report the required change instead.

## Ownership

Exactly one lane owns each directory. Do not create or edit files outside the
directories you own.

| Owner | Directories |
| --- | --- |
| integrator | `src/types.ts`, `package.json`, `package-lock.json`, `tsconfig*.json`, `mise.toml`, `eslint.config.js`, `.prettierrc`, `README.md` |
| git | `src/git/`, `test/unit/git/`, `test/integration/git/`, `test/fixtures/` |
| storage | `spike/`, `src/index/`, `test/unit/index/`, `test/integration/index/` |
| embedding | `src/embedding/`, `test/unit/embedding/`, `test/integration/embedding/` |
| retrieval | `src/history/`, `src/search/`, `test/unit/history/`, `test/unit/search/` |
| cli | `src/cli/`, `src/output/`, `scripts/`, `schema/`, `test/unit/cli/`, `test/unit/output/`, `test/integration/cli/` |
| evaluation | `bench/` |

## Dependencies

Never run `npm install`, `npm ci`, or edit `package.json` / `package-lock.json`.
The integrator owns the lockfile. If your lane needs a new dependency, stop and
report the exact package and why. Prefer the Node standard library: the runtime
dependency budget for the shipped CLI is `@zvec/zvec` and nothing else.

Development-only tooling must never load when a user runs `git why`.

## Code style

- TypeScript, ESM, `.js` extensions in relative imports (NodeNext resolution).
- `strict` and `noUncheckedIndexedAccess` are on.
- No DI framework, event bus, plugin system or generic corpus abstraction.
- Comments explain why, not what. Match the density of `src/types.ts`.
- Throw `GitWhyError` with a specific `GitWhyErrorCode` across boundaries.
- Never compose a shell command from user input. `execFile`/`spawn` with
  argument arrays and `shell: false`.

## Tests

- `test/unit/` — fast, no network, no native model download.
- `test/integration/` — real Git repositories, real Zvec, real locks.
- Use `node:test` and `node:assert/strict`. No test framework dependency.
- Build fixtures by driving real `git` commands, not by hand-writing object files.

## Verifying your work

`npx tsc -p tsconfig.json --noEmit` typechecks the whole tree, including other
lanes that may be mid-flight. Filter the output to your own files.
