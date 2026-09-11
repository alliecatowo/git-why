# Contributing

Git Why is developed as a set of lane-owned directories, each with a narrow,
explicit contract. If you're used to a monorepo where anyone edits anything,
read this first — it's the opposite of that on purpose.

## Setup

```sh
mise setup      # install dependencies from the lockfile, then doctor
mise check      # format, lint, typecheck, protocol hash, plugins, unit tests
mise test:integration
mise test:package
```

`mise doctor` (run automatically by `setup`) verifies tools, native
dependencies, Git capabilities, and benchmark prerequisites before you spend
time chasing an environment problem instead of a real one.

## Ownership

Exactly one lane owns each directory; changes outside your lane's directories
should be reported, not made silently. The current map (see
[`docs/contributing.md`](https://github.com/alliecatowo/git-why/blob/main/docs/contributing.md)
for the authoritative version):

| Owner      | Directories                                                                                                                        |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| integrator | `src/types.ts`, `package.json`, `package-lock.json`, `tsconfig*.json`, `mise.toml`, `eslint.config.js`, `.prettierrc`, `README.md` |
| git        | `src/git/`, `test/unit/git/`, `test/integration/git/`, `test/fixtures/`                                                            |
| storage    | `spike/`, `src/index/`, `test/unit/index/`, `test/integration/index/`                                                              |
| embedding  | `src/embedding/`, `test/unit/embedding/`, `test/integration/embedding/`                                                            |
| retrieval  | `src/history/`, `src/search/`, `test/unit/history/`, `test/unit/search/`                                                           |
| cli        | `src/cli/`, `src/output/`, `scripts/`, `schema/`, `test/unit/cli/`, `test/unit/output/`, `test/integration/cli/`                   |
| evaluation | `bench/`                                                                                                                           |
| site/docs  | `site/`, `.github/workflows/`, `install.sh`, `docs/install.md`                                                                     |

## Code style

- TypeScript, ESM, `.js` extensions in relative imports (NodeNext
  resolution).
- `strict` and `noUncheckedIndexedAccess` are both on.
- No DI framework, event bus, plugin system, or generic corpus abstraction.
- Comments explain _why_, not _what_.
- Throw `GitWhyError` with a specific `GitWhyErrorCode` across module
  boundaries.
- Never compose a shell command from user input — `execFile`/`spawn` with
  argument arrays and `shell: false`.

## Dependency budget

The shipped CLI's runtime dependency is `@zvec/zvec` and nothing else. New
runtime dependencies are a deliberate, reported decision, not a default.
Development tooling (this site included) never loads when a user runs
`git why` — the site has its own `site/package.json` specifically so
documentation tooling never touches the published package's dependency tree.

## Tests

- `test/unit/` — fast, no network, no native model download.
- `test/integration/` — real Git repositories, real Zvec, real locks.
- `node:test` and `node:assert/strict`; no test framework dependency.
- Fixtures are built by driving real `git` commands, not by hand-writing
  object files.

## This site

```sh
cd site
npm install
npm run dev      # local preview with hot reload
npm run build    # static build to site/.vitepress/dist
```

The site has its own `package.json` and lockfile, deliberately separate from
the root one. `docs/report.md` and `docs/operations.md` are included
verbatim into the Benchmarks and Operations pages via VitePress's
`<!--@include-->`, so they can't drift from the source of truth — edit those
files, not the site pages that include them.

## Generated files you cannot hand-edit

Several files are written from a source of truth, and CI fails if you change
them by hand. This is deliberate: across this project's development, eight
separate times a plausible-looking number turned out to come from a broken
denominator, and none of them announced itself.

| File                                                        | Written from                    | Regenerate with                           |
| ----------------------------------------------------------- | ------------------------------- | ----------------------------------------- |
| The numbers in `README.md` and the site's front page        | raw runs under `bench/results/` | `mise bench:report`                       |
| `docs/report.md`                                            | the same                        | `mise bench:report`                       |
| `man/git-why.1`                                             | `git why -h`                    | `mise build`                              |
| The Options tables in [CLI reference](/guide/cli-reference) | `git why -h`                    | `node site/scripts/gen-cli-reference.mjs` |
| `site/public/install.sh`                                    | `install.sh` at the repo root   | the site build                            |

The shell completions in `completions/` are hand-written, but packaging tests
fail if any flag the tool advertises is missing from any of them — as they are
if a flag is missing from the man page.

If a number looks wrong, fix the measurement or the generator, never the text.

## Cutting a release

Push a version tag. The release workflow re-runs every CI gate against the
tagged commit, publishes to npm with provenance, and attaches the tarball to a
GitHub release. It refuses to publish a tag that disagrees with
`package.json`. Full steps are in
[`docs/contributing.md`](https://github.com/alliecatowo/git-why/blob/main/docs/contributing.md).
