# Git Why — one-shot implementation spec

**Semantic archaeology for Git.**  
**Executable:** `git-why` · **Command:** `git why`  
**Revision:** 2026-09-09 · **Status:** implementation handoff; performance results have not yet been measured.

> `git blame` tells you who changed the code. `git why` finds the history that explains why.

Build a small, complete, local Git-history search tool, then demonstrate what it does and does not improve. Preserve the original magic trick:

```sh
git why "that bizarre bug where reconnecting subscribed twice"
```

And there is the change, its actual commit message, and the relevant historical diff.

This document is both the product specification and the execution brief. An implementation agent receiving it should build, test, benchmark, document, and push the project to a public GitHub repository. A scaffold, an unexecuted benchmark script, or another proposal is not the requested completion state.

## 1. Execution contract

The user has authorized implementation, use of mise, parallel work in isolated worktrees, initial evaluation through free OpenCode models, and creation of a public repository. They also have OpenCode connected to DevPass in their development environment. Inspect that environment; do not invent provider IDs, credentials, installed tools, or available free models.

Complete these deliverables:

1. A working TypeScript package exposing the `git-why` executable.
2. A public GitHub repository containing the implementation, this specification, documentation, tests, and reproducible benchmark machinery.
3. A mise setup with pinned tool versions and ordinary npm scripts underneath it.
4. Real extraction, storage, concurrency, installation, and offline smoke tests.
5. An executed retrieval benchmark and an executed OpenCode pilot, with raw measurements and an honest report.
6. A short final handoff giving the repository URL, tested commit, installation command, measured results, and any specific blocked gates.

Make routine implementation decisions autonomously. Resolve conflicting assumptions with a small executable experiment and record the outcome in `docs/decisions.md`. Do not expand the product because a dependency happens to support more features.

If external access is unavailable, finish every independent local deliverable and report the exact blocked action. Never report a skipped benchmark as passed or a local repository as publicly created. Public repository creation is authorized; publishing a package to the npm registry is a separate release action and is not required by this handoff.

The drafting session verified documentation and some Git behavior, but did not have `opencode`, `mise`, or `gh` installed. Nothing in this document is a claim that the application or agent benchmark has already run.

## 2. Product boundary

Git Why retrieves **historical evidence**. It does not generate an explanation of its own.

Its corpus consists of reachable Git commits, their original messages and metadata, changed paths, and bounded evidence from their diffs. Added and removed code both matter. A deletion can be the best answer to a question about an implementation that no longer exists.

V1 does not index current working-tree contents, PR discussions, issues, Actions logs, external documentation, chats, runtime traces, AST graphs, LSP graphs, or multiple repositories. It has no chatbot, remote embedding provider, MCP server, daemon, watcher, installed Git hook, or cloud service.

The agent benchmark may give OpenCode both Git Why and Zvec-Grep. That is an evaluation of complementary tools. It does not bring the workspace corpus into the Git Why package.

The promise is **find the evidence that explains the code**. Historical messages are assertions by their authors, not infallible accounts of intent. Some reasons were never committed. Retrieval must not manufacture those reasons.

## 3. Decisions that replace ambiguous parts of the original

| Area | V1 decision |
| --- | --- |
| Implementation | TypeScript, Node, official `@zvec/zvec` binding; npm packaging; mise for development. |
| Default retrieval | Dense search and native FTS, combined at the commit level with RRF. |
| Embedding | One small local default selected by a bounded comparison; begin with Potion Code 16M v2. |
| Index location | A shared index under the canonical Git common directory. |
| Freshness | A captured ref snapshot; cheap fingerprint check, then full reachable-set reconciliation when needed. |
| Concurrent access | Concurrent readers of a stable index; exclusive updates. No assumption that a writer can coexist with readers. |
| Interrupted writes | An application journal and a tested durable publication protocol, in addition to Zvec's own persistence. |
| Rebuild | Build a replacement generation, validate it, then publish it. Preserve the previous usable index until success. |
| Path filters | Literal historical paths and directory prefixes, matching both sides of an individual rename. No implied rename-chain traversal. |
| Lexical mode | Ranked keyword search. BM25 is not an exhaustive literal or regex search. |
| Dates | Committer timestamps; explicit UTC boundary semantics. |
| Results | Five distinct commits by default, with bounded source excerpts and full SHAs in JSON. |
| Scores | Ranking values, never confidence percentages. |
| Performance | Measure complete fresh-process CLI invocations as well as the inner retrieval loop. |
| Agent evaluation | A four-arm comparison with normal Git tools available in every arm and strict history cutoffs. |

The official Node binding exposes full-text and vector capabilities. Its published concurrency description distinguishes multiple readers from exclusive writes; it does not establish an application-level transaction spanning your collection and metadata files. Verify the installed release rather than copying Python examples into TypeScript. [Official Node binding](https://github.com/zvec-ai/zvec-node), [Node API reference](https://zvec.org/api-reference/nodejs/).

## 4. The experience to ship

```text
$ git why "why do we keep the session when the refresh token is empty?"

1. 91ad203  Fix infinite token-refresh loop
   2025-11-03 · Maya Chen

   Provider X can return an empty refresh token while the current access
   token remains valid. Retrying here puts clients into an infinite loop.

   src/auth/refresh.ts
   - if (!refreshToken) throw new InvalidTokenError()
   + if (!refreshToken) return currentSession

2. 3bc182a  Add regression test for empty refresh response
   2025-11-04 · Maya Chen
   src/auth/refresh.test.ts
   ...
```

This example is illustrative, not a measured result. The real demo must come from a generated fixture or a pinned public repository and must be reproducible from committed commands.

On the first ordinary query, create the index automatically. Report model download, extraction, and embedding as separate progress stages on stderr. Do not display a commit total as an ETA before knowing the number of retained evidence records.

Afterward, ordinary queries check freshness and index newly reachable changes. A user who wants predictable read-only behavior can select `--no-refresh`.

Design the output like a restrained Git command: SHA, subject, date and author, message excerpt, path, diff. No logo, chat prompt, marketing animation, or decorative AI language. Do not launch a pager automatically in V1.

## 5. Command contract

```sh
git why "duplicate websocket events after reconnect"
git why "retry behavior" -- src/network/
git why "token refresh" -- src/auth/session.ts
git why "old queue implementation" -n 20
git why "postgres pooling" --after=2024-01-01 --before=2025-01-01
git why "rate limiting" --author=maya
git why "ReconnectManager" --text
git why "failure caused by reconnecting twice" --semantic
git why "refresh loop" --json --no-refresh
git why --query "index"
git why --query "--experimental"

git why index
git why status
git why status --json
git why rebuild
git why rebuild --use-default-model
git why gc
git why --help
git why --version
```

### Parsing

- Accept one query string. Multiple unquoted positional words before `--` may be joined with spaces, but do not interpret them as revisions.
- `index`, `status`, `rebuild`, and `gc` are reserved command words. `--query` disambiguates a query that would otherwise look like a command or option.
- `--` begins path restrictions. This borrows Git's separator convention; it does not promise the entire Git pathspec language.
- Reject an empty query, contradictory mode flags, invalid dates, invalid limits, and unknown options with a concise corrective error.
- Default `-n` is 5 commits; allowed range is 1–50.
- `--text` means FTS only; `--semantic` means vector only; neither flag means hybrid.
- `--no-refresh` prevents repository-index creation, mutation, recovery, and compaction. It requires an existing clean compatible index.
- `--offline` also prevents model artifact downloads. All Git ingestion is prohibited from fetching objects regardless of this option.
- `--max-bytes` bounds rendered output, including JSON framing; default 16 KiB, maximum 256 KiB. Report clipping explicitly. It must never produce invalid JSON.
- `--lock-timeout` is seconds, default 30. It bounds waiting for another process, not the caller's own indexing operation.

FTS-only retrieval need not load the embedding model when using an existing current index. Initial indexing or a refresh still creates the normal hybrid index and therefore needs its embedder. An offline user whose model is unavailable can use `--text --no-refresh` against an existing index. Do not silently create a different index or silently switch hybrid queries to lexical mode.

### Paths

Resolve relative restrictions against the caller's directory, then normalize to repository-relative paths without requiring the historical file to exist now. In a bare repository, restrictions are already repository-relative. Reject restrictions escaping the repository root. Do not resolve a deleted path or historical symlink through the current filesystem. A trailing `/` means a directory prefix; otherwise the restriction is a literal file path. Multiple restrictions are ORed. Date, author, and path restrictions are ANDed with one another.

Match both `path` and `oldPath` on the individual historical change. Match a commit summary when any of its changed paths satisfies the restriction. A file restriction must not select an unrelated hunk merely because another file in the same commit matched.

Do not pass user path strings directly into a database expression. Use a tested typed filter builder. Reject unsupported glob/pathspec syntax with an explanation instead of pretending to implement it.

`-- src/new.ts` can find the commit that renamed `lib/old.ts` to `src/new.ts`. It does not automatically find every earlier commit to `lib/old.ts`. That would require a separate lineage feature. Git's diff machinery documents rename detection, while ancestry following is a separate concern. [Git diff-tree](https://git-scm.com/docs/git-diff-tree).

### Dates and authors

Use committer time for ordering and date restrictions. Preserve author time separately in JSON. Date-only `--after=2025-01-01` means at or after `2025-01-01T00:00:00Z`; `--before=2025-01-01` means strictly before that instant. Also accept ISO timestamps containing an explicit timezone. Reject locale-dependent date expressions in V1.

`--author` is a case-insensitive literal substring of original author name or email, not a regular expression. Do not silently apply a changing `.mailmap` to indexed identities.

### Process behavior

| Exit | Meaning |
| --- | --- |
| 0 | Successful command, including zero results. |
| 2 | Invalid invocation. |
| 3 | No usable Git repository. |
| 4 | Index, model, storage, compatibility, or extraction failure; machine error code distinguishes the cause. |
| 5 | Index lock wait exceeded. |
| 130 | User interruption. |

Respect `NO_COLOR`, terminal capability, and whether stdout is a TTY. Sanitize terminal control sequences in every repository-sourced string, including subjects, authors, paths, and diff lines. JSON preserves valid data through JSON escaping. Handle broken pipes cleanly without a stack trace.

### Lifecycle commands

`index` creates or reconciles the normal hybrid index and explicitly retries obtainable missing evidence. `status` is read-only: it never downloads a model, repairs storage, or starts indexing. It reports index location, indexed/reachable counts where known, record count, model identity, disk use, coverage omissions, and one of `missing`, `current`, `stale`, `incomplete`, `busy`, `recovery_required`, or `rebuild_required`. A cheap check may report “refs changed” instead of pretending to know an exact number of new commits. Distinguish a caught-up shallow index from a complete-history clone.

`rebuild` replaces derived index data using the recorded model when supported; on a missing index it uses the current default. `rebuild --use-default-model` explicitly migrates to the current built-in default. `gc` reconciles eligible history without downloading embeddings, removes ineligible/abandoned derived records, and compacts when supported; it does not mark unindexed new commits complete. All mutations take exclusive access. JSON status uses `schemaVersion: 1`, `command: "status"`, and a documented status object rather than a fake search response.

## 6. Git repository and history contract

Never assume `.git` is a directory. Ask Git for its absolute common directory and resolve its canonical filesystem identity. All worktrees belonging to the same repository must select the same index and lock paths. Bare repositories work for history search; an empty repository produces an empty result without downloading a model unnecessarily. [Git rev-parse](https://git-scm.com/docs/git-rev-parse).

Define the default history scope explicitly:

- All commit ancestors of local branch tips, remote-tracking branch tips, and tags that peel to commits.
- The HEAD of every registered, accessible worktree, including detached HEADs.
- No reflog-only objects, stash refs, notes, replace refs, or arbitrary application refs.
- No recursive traversal into submodules; a submodule has its own repository and index.

Capture these tips once at the start of reconciliation. Deduplicate and sort the OIDs. Pass explicit resolved OIDs to `git rev-list --stdin`; do not repeatedly resolve moving branch names during the same refresh. Retain the captured fingerprint in the manifest. Failure to enumerate a registered worktree's HEAD makes the snapshot incomplete and prevents pruning; a temporarily inaccessible worktree is not proof that its history became ineligible.

`git rev-list --all` is useful for understanding the original proposal, but its scope is broader than the explicit policy above. It also examines other worktrees by default. A detached worktree is therefore not a benchmark history boundary. [Git rev-list](https://git-scm.com/docs/git-rev-list).

Normal commits are immutable. The *available view* of a repository can still change when a shallow clone deepens, missing objects become available, or interpretation settings change. The fingerprint includes:

- Captured eligible ref names and OIDs, plus worktree HEAD OIDs.
- Shallow-boundary contents, not merely a boolean.
- Object format and extraction-policy version.
- The supported Git extraction configuration fingerprint.

Disable replace-object interpretation for ingestion. Detect legacy grafts and return an unsupported-history-override error. Preserve Git's own repository trust checks. Do not modify `safe.directory` to make an error disappear.

A search describes the repository snapshot captured when its freshness check started. If refs move during indexing, complete a coherent captured snapshot and mark that another refresh is available; do not loop forever trying to catch an actively changing repository.

## 7. Extraction: trust Git, parse its machine interfaces

Build an extractor that streams records independently of storage and embeddings:

```ts
interface HistoryExtractor {
  extract(snapshot: RepositorySnapshot): AsyncIterable<HistoryRecord>;
}
```

Use a small number of batched Git processes. `git cat-file --batch` provides object-size framing for commit objects. `git diff-tree --stdin` can batch change and patch extraction. A bounded process pool per commit is an acceptable first correct implementation; unbounded spawning or one Git invocation per metadata field is not.

Required behavior:

- Pass argument arrays with `shell: false`; never compose a shell command from a query, ref, or path.
- Use NUL-delimited change metadata for filenames. Git permits spaces, tabs, newlines, quotes, and non-UTF-8 bytes in paths.
- Preserve original path bytes for identity; derive a separate safe display string. JSON supplies `pathBytesBase64` when decoding cannot round-trip the original bytes.
- Parse unified hunks with an explicit state machine. Do not split a patch on an arbitrary `diff --git` substring inside file content or whitespace-split path headers.
- Store exact source excerpts separately from normalized search text.
- Fix diff context and algorithm, prefixes, rename threshold, and rename limit. Include these choices in extraction-policy identity.
- Disable external diff commands, textconv, color, and paging. Do not execute repository-defined conversion programs.
- Set no-lazy-fetch behavior and disable interactive Git prompts. Merely reading a partial clone can otherwise trigger a fetch. [Git global options](https://git-scm.com/docs/git).
- Bound stdout/stderr processing and memory. A pathological commit must not become a giant in-memory string before the cap is applied.

### Commit cases

| Case | Treatment |
| --- | --- |
| Ordinary commit | Message, metadata, paths, and meaningful diff evidence against its sole parent. |
| True root | Verify the commit object has zero parents; diff against the appropriate empty tree. Do not hard-code a SHA-1 empty-tree hash. |
| Merge | Message and metadata, all parent OIDs, and changed-path metadata relative to the first parent. No merge diff hunks in V1. Flag this coverage choice. |
| Rename | Store both byte-preserving paths and similarity metadata. A rename without a textual hunk still gets file-change evidence. |
| Deletion | Index removed code and historical path. |
| Mode-only or binary change | Keep summary and file-change metadata; no fabricated textual patch. |
| Submodule pointer | Keep old/new gitlink OIDs and path as file-change metadata; do not index the submodule's objects. |
| Shallow boundary | A missing parent is not a root. Keep available message/path evidence, label missing ancestry, and retry when deepening changes the fingerprint. |
| Missing blob/tree | Keep obtainable evidence and a precise omission reason. Never fetch automatically or mark missing diff material fully indexed. |

V1 can miss reasoning encoded only in a merge conflict resolution, excluded file, or unavailable object. That is a documented coverage limitation, not permission to invent an answer.

## 8. Records and identity

Use one searchable Zvec history collection per active index generation. Keep two top-level record types:

1. `commit`: one summary per commit.
2. `evidence`: one meaningful hunk slice, or file-change metadata where no textual hunk exists.

This handles renames, deletions, and mode changes without pretending everything is a code hunk.

```ts
type EvidenceKind = "hunk" | "file_change";

interface CommitRecord {
  type: "commit";
  id: string;
  sha: string;
  parents: string[];
  subject: string;
  body: string;
  author: { name: string; email: string; time: number };
  committerTime: number;
  changedPaths: HistoricalPathChange[];
  semanticText: string;
  lexicalText: string;
  coverage: Coverage;
}

interface EvidenceRecord {
  type: "evidence";
  kind: EvidenceKind;
  id: string;
  sha: string;
  parentSha: string | null;
  path: HistoricalPath;
  oldPath: HistoricalPath | null;
  changeType: string;
  hunkOrdinal: number | null;
  sliceOrdinal: number;
  header: string | null;
  oldStart: number | null;
  oldCount: number | null;
  newStart: number | null;
  newCount: number | null;
  sourceExcerpt: string;
  semanticText: string;
  lexicalText: string;
  coverage: Coverage;
}
```

These are conceptual TypeScript contracts. The physical Zvec schema may flatten fields and encode nonscalar payloads. It must not assume JavaScript objects are accepted as arbitrary database scalar fields.

Use full Git object IDs, supporting SHA-1 and SHA-256 repositories. Construct fixed-length deterministic document IDs from a versioned, unambiguously framed tuple containing record type, commit OID, parent OID, original path bytes, hunk ordinal, and slice ordinal. A SHA-256 digest of that tuple avoids delimiter ambiguity, path disclosure in IDs, and database ID-length surprises.

Do not use a six-character path hash or insertion sequence. Explicitly test the binding's ID constraints in the capability spike.

### Searchable fields

Store and index the fields actually used for eligibility: record type, commit SHA, committer time, normalized author search value, and historical path-match keys. Preserve full metadata and exact excerpts for fetching the final results.

For paths, a match-key array may include a file's complete normalized path and each directory prefix. A summary's keys cover its changed paths; a hunk's keys cover only its own old/new paths. Verify native array filtering, cardinality limits, and prefix behavior before selecting the physical representation. If the binding lacks an adequate array filter, use a small sidecar path catalog to compute eligible IDs before retrieval. This is a bounded storage-adapter detail, not a graph or second search service.

Eligibility must precede top-k selection in both branches. If filters must be implemented through ID partitions, retrieve and merge the partitions correctly. Filtering only the first unfiltered top-k results is not acceptable.

Never return stored embeddings in normal search, status, or JSON output. Fetch only the fields needed for the chosen commits.

## 9. Search text and bounded ingestion

Keep three concepts separate:

- **Source excerpt:** faithful, displayable historical evidence.
- **Semantic text:** the input to the embedding model.
- **Lexical text:** text normalized for keyword retrieval, including original identifiers and searchable identifier components.

A hunk's semantic text includes a bounded subject and body excerpt, file and context, and meaningful removed/added code. Use explicit labels such as `Removed code` and `Added code`; small static embeddings may not reliably represent the direction carried by `-` and `+` alone.

Budget the input with the actual tokenizer. Reserve room for code so a long commit message cannot consume the entire hunk representation. Start with at most 25% of the input budget for repeated message text. Split oversized hunks at change-block or line boundaries into bounded slices, carrying coordinates and a small amount of context. Preserve both deleted and added sides of a change when possible.

Lexical normalization retains original tokens while adding camelCase, snake_case, path, and version components. Keep numbers. Do not confuse `13` with `18`, or `AuthSessionProvider` with three unrelated words. Default keyword matching is ranked retrieval; exhaustive matching remains a job for Git's pickaxe or ripgrep.

Initial policy constants, all versioned and reported:

| Limit | Starting value |
| --- | --- |
| Semantic input | min(model limit, 1,024 tokens), with explicit metadata budget. |
| Stored source excerpt per slice | 8 KiB maximum, with a clipping flag. |
| Message text retained for search | 16 KiB per commit; record any omitted tail. |
| Parsed textual patch per commit | 2 MiB before treating the commit as pathological. |
| Embedded evidence per commit | At most 64 slices and 32,768 total input tokens. |
| Changed paths in embedded summary | At most 128; retain the full available path catalog separately. |
| Rename detection | Fixed similarity threshold and bounded candidate work, recorded in policy. |

For oversized commits, inspect changed-file metadata first. Prioritize a deterministic spread of source and test files and round-robin across files before consuming the entire budget on one file. If extraction cannot continue within bounds, keep the summary and metadata and report the omission. No random sampling.

Default skip rules cover binaries, common dependency lockfiles, obvious minified artifacts, and confidently identified generated/vendor content. A broad rule such as “skip all JSON” or “skip all snapshots” would discard useful history and is prohibited. Retain configuration, dependency manifests, migrations, and ordinary tests. Always retain available commit summaries and change metadata, including for skipped patches.

Coverage has machine-readable reasons, such as `binary`, `generated`, `size_limit`, `message_limit`, `missing_object`, `shallow_boundary`, and `merge_hunks_omitted`. Counts distinguish intentionally excluded material from unavailable history and failed extraction.

“Deleted code is searchable” means retained added/removed historical evidence is searchable. It does not promise that every complete historical file version has been embedded.

## 10. Embedding decision

Start with `minishlab/potion-code-16M-v2`: a static Model2Vec model with 256-dimensional embeddings and an MIT model license. It is a plausible low-startup-cost default for this CLI, not a proven winner on Git history. [Model card](https://huggingface.co/minishlab/potion-code-16M-v2).

Compare no more than three candidates in the initial spike:

1. Potion Code 16M v2.
2. Potion Retrieval 32M, to test whether message-heavy history favors a prose retrieval model.
3. A small locally supported MiniLM-class transformer as a quality/startup reference.

Zvec-Grep documents both small static and transformer-backed local choices, but its internal model identifiers and runtime packaging are not a Git Why dependency contract. Pin the actual model repository, revision, artifact hashes, tokenizer, pooling, dtype, and normalization used by Git Why. [Zvec-Grep embedding documentation](https://github.com/zvec-ai/zvec-grep/blob/main/docs/07-embedding.md).

```ts
interface Embedder {
  fingerprint: string;
  dimension: number;
  maxInputTokens: number;
  embedDocuments(texts: readonly string[]): Promise<Float32Array[]>;
  embedQuery(text: string): Promise<Float32Array>;
  dispose(): Promise<void>;
}
```

Prefer an existing maintained JS implementation or a small attributed adaptation of compatible upstream static-inference code. Do not depend on undocumented Zvec-Grep CLI internals, require Python in the installed product, or quietly add a llama server. Verify a static implementation against reference output on fixed inputs; tokenizer, pooling, and normalization errors can make an apparently working index useless.

Use one production embedder by default. Candidate-only dependencies belong in benchmark tooling where possible. Do not ship a model zoo to solve a one-model decision.

Selection rule: use the smallest candidate that meets the preregistered development-set retrieval floor. Require a material measured quality gain before accepting a slower model. Freeze this decision before examining held-out results. If no candidate demonstrates useful retrieval, report that result and fix the representation or ranking on development data; do not cherry-pick demo queries.

Model artifacts live in a user-level cache outside individual repositories. Download lazily, use pinned trusted artifact locations and checksums, write through temporary files, and coordinate concurrent downloads. Once cached, normal operation is offline. Do not execute model-supplied remote code or send repository text to a model host.

Changing model weights, tokenizer, pooling, normalization, or dimensions changes the fingerprint and requires a rebuild. Identical vector dimensions do not imply compatibility. Ordinary queries continue using the index's supported recorded model; a newly released default must not silently rebuild a user's index.

## 11. Storage layout

All repository-specific state is under `<GIT_COMMON_DIR>/why/`. Express the layout as paths rather than assuming a working-tree directory:

| Path | Purpose |
| --- | --- |
| `CURRENT` | Atomically published active generation identifier. |
| `locks/repository.lock` | Stable shared/exclusive coordination lock; never replace it during rebuild. |
| `generations/<id>/manifest.json` | Versions, scope fingerprint, model identity, counts, coverage, timestamps. |
| `generations/<id>/collection/` | The Zvec history collection. |
| `generations/<id>/commits.jsonl` | Compact indexed-commit catalog/checkpoints, if needed by the storage adapter. |
| `generations/<id>/pending.json` | Durable intent for an incomplete update batch; absent when clean. |
| `staging/<id>/` | Incomplete first build or replacement build. |

A generation is an on-disk index version, not a new corpus. Incremental refresh updates the active generation in place under exclusive access. A full rebuild creates a replacement generation. Do not copy the full database on every query or every commit.

The manifest contains small metadata. Do not put embeddings, full patches, or giant commit arrays in it. The compact commit catalog is an implementation detail, not a second retrieval engine. It must have a declared relationship to database durability and recovery.

Include these identities in the manifest: manifest version, record schema version, extraction policy, lexical normalization, embedding fingerprint, ranking version, object format, snapshot fingerprint, database format compatibility, counts, omission counts, created/updated times, and clean/recovery state.

No account names, tokens, remote credentials, or absolute original clone path are needed to identify a movable local index. Use the resolved common directory for operation, not as a secret embedded identifier.

## 12. Incremental refresh and recovery

The algorithm is deliberately simple:

1. Capture the eligible tips and repository-view fingerprint.
2. If the clean compatible index already covers that fingerprint, search it.
3. Otherwise acquire exclusive access and recheck: another process may have completed the work.
4. Enumerate the complete reachable set for the captured tips.
5. Compute new, previously incomplete, and now-ineligible commits.
6. Extract and embed new or retryable commits in bounded batches.
7. Apply idempotent record updates and reconcile stale records.
8. Publish durable catalog/manifest checkpoints and clear the journal.
9. Release exclusive access and query a stable index.

Incomplete objects are retried on a changed repository view and on an explicit `index`; normal queries need not repeatedly retry unchanged missing blobs. A failed or interrupted enumeration must never be interpreted as an empty reachable set and used to delete the index.

Rebases and force pushes may make old commits ineligible. Stash or reflog retention does not keep them in this tool's default scope. Remove ineligible records during successful reconciliation; `gc` handles deferred compaction and unused generations. Git Why's GC never invokes destructive Git object GC or changes Git refs.

### Application durability

Zvec's WAL does not atomically update a separate manifest. Implement and test a small journal:

- Record pending commit additions/replacements/deletions durably before applying the batch.
- Use deterministic IDs; replay may delete and recreate the affected commit's evidence.
- Verify per-record operation outcomes, including APIs that return partial failure results.
- Make the completed collection state durable using the installed binding's documented guarantees. Do not call an imaginary `flush()` method.
- Only then publish the catalog checkpoint and manifest state; clear the pending marker last.
- Readers reject a generation with pending recovery. Default queries recover under exclusive access; `--no-refresh` returns `INDEX_RECOVERY_REQUIRED`.

The concrete adapter can use successful close/reopen as a checkpoint if that is the verified API contract. The shared/exclusive application lock remains held across all of these steps. Crash tests, not an optimistic comment, establish the guarantee.

For rebuilds, fully create and validate staging, close all collection handles, rename the completed generation into place, and atomically publish `CURRENT` on the same filesystem. Keep the previous generation until the replacement is confirmed usable; remove it during controlled cleanup. A failed rebuild must not first delete the only working index.

Reject symlinked or unexpected owned-index paths before recursive cleanup. Never recursively delete the Git common directory. Peak rebuild disk consumption can approach the sum of old and new generations; report it.

## 13. Concurrency without a daemon

Guarantee concurrent readers of stable data and one exclusive updater. A writer lock alone is insufficient if readers continue opening a collection being rebuilt or replaced.

Use a tested cross-process shared/exclusive advisory-lock backend on the stable repository lock file. Readers hold shared access from manifest validation through collection close. Writers hold exclusive access through mutation, metadata publication, recovery, and cleanup. Locks must be released by process termination. Do not steal a live process's lock because a timer elapsed.

The particular Node lock package is selected in the capability spike based on actual platform and packaging support. This is one bounded dependency decision. Native Zvec locking may implement part of the protection only if the executable probe establishes the entire lifecycle contract, including metadata and replacement races. Do not assume an undocumented locking API exists.

Sequence a freshness upgrade safely: release shared access, acquire exclusive access, and recheck the snapshot and manifest. Never hold a shared lock while waiting to upgrade in a way that can deadlock another updater.

Load a cached query embedder before taking the short read lock where possible. Do not keep a read lock open while rendering output to a slow pipe. Initial index construction may hold exclusive access for a while; other commands wait up to their lock timeout and then return `INDEX_BUSY` with the status and a useful next step. V1 does not serve the actively mutated collection as a stale snapshot.

Bound embedding concurrency and threads. Eight agent queries must not each spawn an unconstrained thread pool. Measure aggregate process-tree memory for parallel readers, not only the first process's heap.

Release support only for OS/architecture/runtime combinations that pass the real lock and package tests. Linux and macOS are the initial priorities; native Windows support is conditional on those tests, with WSL documented separately. Network filesystem locking is outside the initial guarantee.

If a platform can only safely serialize queries, expose and benchmark that limitation; do not advertise concurrent reads there. An unsupported locking contract blocks declaring that platform supported.

## 14. Retrieval and ranking

Use identical eligibility filters in both retrieval branches. Start with normalized FP32 embeddings, cosine similarity, and the simplest suitable Zvec vector index. Use approximate indexing only with its recall checked against an exact-search reference on the evaluation corpus. Do not begin with exotic quantization or DiskANN tuning.

Candidate algorithm:

1. Fetch up to `max(80, 16*n)` eligible evidence/summary records from FTS and from the vector branch, subject to an implementation cap established by the probe.
2. Within each branch, collapse records to unique commits, ordered by the best record score. Break ties deterministically.
3. Assign ranks **after** this collapse, so twenty hunks from one commit do not displace twenty distinct commit ranks.
4. Fuse the two unique-commit rankings with RRF, using `k = 60` initially.
5. Fetch summary metadata and choose up to two nonredundant evidence excerpts per winning commit.

For commit `c`:

```text
score(c) = 1 / (60 + lexicalCommitRank(c))
         + 1 / (60 + semanticCommitRank(c))
```

A missing branch contributes zero. Single-mode search uses its branch ranking directly. Do not add raw BM25 and cosine values. Do not normalize the result into an invented probability.

If the initial candidate pool contains fewer than `n` unique eligible commits, expand geometrically up to the bounded cap or exhaustion. If a cap still limits diversity, expose `candidateLimitReached`; do not quietly claim an exhaustive result set.

No corroboration bonus in the first implementation: repeating the same commit message across hunks is not independent evidence. Add a capped bonus only if an ablation on development data demonstrates a benefit without favoring huge commits.

Use a stable SHA tie-break for otherwise identical ranking values. Do not silently favor recent commits. Relevant introduction, reversion, and removal commits can all appear; similarity is not a causal timeline, and timestamps alone do not establish ancestry.

For FTS, compile the user's string as literal query terms using the supported native API. Do not interpret natural-language punctuation as database query syntax. Preserve exact identifier and numeric terms in tokenization tests. [Node FTS index options](https://zvec.org/api-reference/nodejs/interfaces/ZVecFtsIndexParams.html).

## 15. Evidence and JSON

Human output contains direct message excerpts and source diffs, with omission markers where needed. A summary-only result is valid. Never attach an unrelated hunk just to make every result look substantive.

Do not display weak matches as “the reason.” Use neutral result language. An empty candidate set means no match in the available indexed material; it does not prove the repository contains no explanation. A vector engine generally returns neighbors even for a bad question, so arbitrary score thresholds are not a substitute for evaluation.

Stable machine envelope:

```json
{
  "schemaVersion": 1,
  "query": "auth refresh loop",
  "mode": "hybrid",
  "snapshot": {
    "scope": "branches-remotes-tags-worktree-heads",
    "fingerprint": "opaque-fingerprint",
    "indexedAt": "2026-09-09T17:03:13Z",
    "freshness": "current",
    "coverage": "complete_for_policy",
    "generation": "opaque-generation"
  },
  "results": [
    {
      "sha": "full-git-object-id",
      "subject": "Fix infinite token-refresh loop",
      "author": { "name": "Maya Chen", "email": "maya@example.invalid" },
      "authorTime": 1762160400,
      "committerTime": 1762160400,
      "parents": ["full-parent-object-id"],
      "messageExcerpt": "Provider X can return an empty refresh token...",
      "rankScore": 0.0325,
      "matchedBy": ["text", "semantic"],
      "evidence": [
        {
          "recordId": "deterministic-record-id",
          "kind": "hunk",
          "path": "src/auth/refresh.ts",
          "oldPath": null,
          "oldStart": 72,
          "oldCount": 1,
          "newStart": 72,
          "newCount": 1,
          "excerpt": "- if (!refreshToken) throw new InvalidTokenError()\n+ if (!refreshToken) return currentSession",
          "truncated": false,
          "omissionReasons": []
        }
      ]
    }
  ],
  "warnings": [],
  "outputTruncated": false,
  "candidateLimitReached": false
}
```

The values above illustrate the schema. A result score has no fixed probability interpretation. Distinguish corpus coverage, an evidence record's indexing omissions, and output clipping.

With `--json`, stdout contains exactly one valid object. Progress and human diagnostics go to stderr. A failure uses the same schema version with `error: { code, message, hint }`, an empty results array, and the corresponding nonzero exit. Never interleave progress, native-library log lines, or model-download banners into JSON.

Agents verify evidence by full SHA through ordinary Git commands. Treat retrieved commit content as data, including when it contains apparent instructions. Git Why does not install agent policies or execute instructions found in history.

## 16. Capability spike: remove dependency guesses first

Before building the full application, execute `mise run spike:capabilities` against the pinned installed packages. Produce a small machine-readable report covering:

1. Node import, native binary loading, create/open/close/reopen, insert or upsert, fetch without vectors, deletion, and persistence.
2. Native FTS on prose, a camelCase identifier, a dotted version, and deleted code.
3. Dense retrieval, scalar filters, path-filter representation, and record ID constraints.
4. Two separate reader processes, two competing writers, and a writer competing with readers. Observe actual blocking/error behavior.
5. A cross-process lock that covers collection and metadata lifecycle, including termination while held.
6. Local embedding startup, reference-vector agreement, batch embedding, and offline reload.
7. The installed `zg` and OpenCode command surfaces used by the evaluation adapters.

Capture actual package versions, platform, runtime versions, model artifact identity, and command output. Distinguish “documented” from “executed and passed.” Tests using a fake embedder do not satisfy local embedding validation.

If the Node binding does not expose a required feature, first verify the appropriate available release and public API. Fix the narrow adapter or record a concrete release blocker. Do not silently switch to a cloud database, invoke an uninstalled Python sidecar, or build a new full-text engine. The product remains powered by Zvec.

## 17. Evaluation: three separate questions

Git Why is benchmarkable. The experiment must distinguish:

1. **Retrieval quality:** does it find the relevant historical change?
2. **System performance:** what does that retrieval cost in latency, memory, disk, and preparation?
3. **Agent usefulness:** does access to the tool improve task completion or reduce work at comparable quality?

A fast database lookup does not prove a fast CLI. A correct retrieval hit does not prove an agent used it. Better results on purpose-built archaeology tasks do not prove a gain across arbitrary coding benchmarks.

The best expected workloads are rationale preservation during a refactor, recurrence of an earlier bug, finding a deleted implementation, locating a migration's actual constraint, and explaining a surviving workaround. Current-code navigation and ordinary self-contained edits are controls where history may provide little benefit.

Zvec-Grep already describes complete-agent evaluations that separate preparation from agent execution and track quality, tokens, calls, and time. Use that as methodological precedent; do not import its reported improvements as expected Git Why results. [Zvec-Grep benchmark methodology](https://zvec.org/en/docs/zvec-grep/benchmarks/).

The benchmark lives under `bench/`, is excluded from the distributed CLI, and remains a small runner, fixture generator, scorer, and report generator. Do not build an experiment platform or add benchmark orchestration to the product runtime.

## 18. Benchmark A — historical retrieval

### Minimum executed suite

Create 48 labeled natural-language queries across at least six independently constructed fixture histories, with multiple plausible distractors in each. Use 24 for development and 24 as held-out tests. Include eight no-evidence cases across the suite and stratify them between splits. Keep paraphrases of the same underlying change in the same split.

Make the histories plausible: terse and verbose messages, bug-introducing commits, partial fixes, similar fixes in different subsystems, renames, reversions, old implementations, ordinary churn, and version-number distractors. A 10-commit repository with one obviously relevant message is a smoke test, not convincing evidence of retrieval quality. Aim for hundreds of history records per fixture repository, with generators allowing larger distractor sets.

Add a separate external-validity check of at least 12 manually inspected questions over at least two public histories when accessible. Pin repository URL, license, cutoff SHA, relevant SHAs, and queries before running the scorer. Keep its development/test split explicit. If this part is inaccessible, report synthetic-only evidence and do not claim real-repository validation.

Do not generate a query by simply copying the target commit subject. Query authors should express a developer's task or memory. Prefer a separate dataset-authoring lane that seals held-out cases before tuning. Keep labels out of tuning scripts and benchmark trial agents. If the same implementation agent has already seen the test cases, acknowledge that dependence and do not describe the holdout as blinded.

### Required categories

| Category | Example question | Required check |
| --- | --- | --- |
| Synonym mismatch | “messages arriving twice after reconnect” | Relevant resubscription/double-dispatch fix. |
| Workaround rationale | “why keep this empty-token branch?” | Message establishing the specific upstream behavior. |
| Deleted implementation | “the queue before we moved to workers” | Removed or replaced implementation evidence. |
| Migration | “why stop using redis locks?” | Actual migration constraint, not unrelated Redis changes. |
| Exact identifier | “AuthSessionProvider” | Preserve strong lexical performance. |
| Number/version | “why drop postgres 13?” | Distinguish nearby versions and unrelated packages. |
| Rename | Query an old concept; filter old/new paths | Respect the documented single-change rename behavior. |
| Poor message, rich diff | “fix duplicated listener registration” | Relevant code despite a subject such as “fix issue”. |
| Rich message, skipped patch | Dependency/configuration change | Summary survives patch suppression. |
| Lifecycle | “Safari cookie workaround” | Introduction and removal are both recognized as relevant where labeled. |
| Distractor intent | Similar token changes in another provider | Correct subsystem and constraint. |
| No evidence | Ask for an unrecorded motivation | Measure irrelevant neighbors; do not invent a confident reason. |

Each case records the permitted corpus snapshot, relevance labels, optional filter, expected supporting evidence, and why distractors are not answers. Relevant SHAs are evaluator data, not text included in the indexed documents.

### Comparisons

Run the same extraction and eligibility policy with:

- FTS only.
- Vector only for each candidate model.
- Hybrid for each candidate model.

Include one ablation on development data comparing commit summaries alone against summaries plus diff evidence. This tests whether diff ingestion earns its complexity. Do not multiply the full held-out suite into an endless tuning grid.

Measure commit-level `Hit@1/3/5`, multi-relevant `Recall@5`, and `MRR`. Use correct denominators: “at least one relevant hit” is not recall of every relevant commit. For no-evidence questions, separately report what the system returns and whether an apparent explanation would be unsupported; exclude them from metrics requiring a known relevant SHA.

Before tuning, write the initial development target into `bench/protocol.json`: at least 75% Hit@5 on answerable semantic-archaeology development cases, with exact-identifier performance reported separately. This is a provisional product-quality floor, not a statistical claim. The smallest candidate meeting it is the default unless a documented material gain justifies extra cost.

Freeze representation, embedding, ranking, thresholds, and limits before the held-out run. If the held-out result is disappointing, publish it. Any subsequent tuning needs a new evaluation version and an unused holdout.

Persist per-query ranked SHAs, relevance matches, candidate counts, timing, and omission flags. The report includes unsuccessful cases, not only a curated demo.

## 19. Benchmark B — end-to-end OpenCode usefulness

The user's proposed comparison is the main experiment, with one additional arm to isolate Git Why's contribution.

| Arm | Tools available to the same OpenCode model |
| --- | --- |
| A — baseline | Normal OpenCode tools, shell, file reading/editing, ripgrep, tests, and native Git history commands. |
| B — workspace | A + Zvec-Grep (`zg`) over the current task workspace. |
| C — workspace + history | A + the identical `zg` setup + `git why` over the permitted history. |
| D — history | A + `git why`, without `zg`. |

“Zvec added” here means Zvec-Grep: Zvec itself is the storage engine, not an agent-facing code-search command.

Primary comparisons are C versus B and D versus A. B versus A measures workspace retrieval. C versus A measures the combined package. Also report the interaction `(C - B) - (D - A)` descriptively if sample size permits; do not attribute all of C's gain to Git Why.

**Never cripple the baseline by hiding Git history.** A can use `git log`, `git show`, `git blame`, `git log -S`, and `git log -G`. The experiment is whether Git Why helps an agent find and use the same available evidence more effectively.

### Workloads

Prepare a fixed eight-task pilot:

| Task | Kind | Example setup | Success criterion |
| --- | --- | --- | --- |
| T1 | Preserve rationale | Simplify session refresh while preserving an old provider-specific empty-token behavior. | Hidden behavior tests pass; relevant historical constraint is correctly cited. |
| T2 | Recurrent regression | A reconnect path reintroduces duplicate dispatch through a different function. | New reproduction and prior regression tests both pass. |
| T3 | Deleted approach | Recover a useful part of an earlier queue implementation within the new interface. | Required behavior restored without reinstating a known old defect. |
| T4 | Architecture constraint | Modify retry behavior while respecting a historical non-idempotency limitation. | Correct retry and no-double-effect tests pass. |
| T5 | Evidence question | Explain why a compatibility workaround appeared and when it was removed. | Supported facts and valid ancestor-SHA citations; no fabricated motivation. |
| T6 | Current-code control | Locate and repair an ordinary distributed configuration bug. | Hidden regression tests pass. |
| T7 | Simple-edit control | Implement a localized behavior fully specified in the task. | Hidden behavior tests pass; history was unnecessary. |
| T8 | No-evidence control | Ask whether committed history establishes a purported rationale that is absent. | Appropriate uncertainty, no invented supporting commit or causal story. |

These are templates for concrete fixtures, not instructions to make history the only permitted solution. A capable baseline may infer the correct behavior or find it with normal Git. That is a valid outcome.

For coding tasks, graders use hidden behavioral tests, not just agent-written tests or patch similarity. Include checks for plausible regressions such as duplicate effects, token loss, dropped messages, ordering, and compatibility where the scenario calls for them. For T5/T8, use a fixed evidence-and-facts rubric and verify cited SHAs exist in the allowed ancestry.

Do not use the trial model to grade its own answer. For this small pilot, blinded manual review against the rubric is sufficient and avoids buying an LLM judge. Record the grade and short justification for every answer. Coding test outcomes remain the primary objective metric.

### Equal treatment

Use identical task wording, base snapshot, model/provider, reasoning settings, common instructions, built-in tools, permitted tests, and budgets. Only the offered retrieval tools and their concise usage cards differ. Do not give C a bespoke hint naming the target commit or instruct it to call Git Why first when the baseline receives no corresponding history guidance.

Make every arm aware that source and permitted history are available. Let the model decide whether to search history. Track tool adoption. If the tool is useful when forced but ignored in ordinary runs, that is a discoverability result, not evidence that normal agent performance improved.

Use direct CLI integration for the primary experiment: OpenCode invokes `zg` and `git why` through its normal shell tool. No Git Why MCP server is needed. Disable unrelated global MCP additions and special personal prompts through a verified isolated benchmark profile, while preserving the selected provider credentials through the supported auth mechanism.

B and C use the same pinned `zg` version, local model, direct/server policy, exclusion rules, and refresh policy. Prefer direct mode for the first comparison; measure its real startup costs. Verify exact invocation syntax through installed help because the published CLI has changed between releases. [Zvec-Grep CLI reference](https://zvec.org/en/docs/zvec-grep/cli/), [execution modes](https://github.com/zvec-ai/zvec-grep/blob/main/docs/06-server.md).

## 20. Benchmark isolation: worktrees alone are insufficient

Git worktrees share refs, object storage, and the common metadata directory. A worktree at yesterday's commit can still expose tomorrow's fix through other refs. Giving Git Why a cutoff flag would not fix a baseline that can still discover future objects with native Git.

Use this sequence:

1. Resolve a task's `baseSha` and its permitted ancestor set.
2. Create an export containing only that history: for example, bundle one temporary ref at `baseSha` from a disposable source checkout. Never export with `--all`.
3. Build a clean task seed from the export. Verify its refs and object inventory do not contain held-out fix commits, gold patches, future implementations, or unrelated branches. Do not leave an object alternate or remote route back to the full repository.
4. Give each arm/trial its own disposable repository cloned from that clean seed, with a detached worktree for the task. Independent trials must not share writable Git refs or Git Why indexes.
5. Keep gold patches, expected SHAs, graders, hidden tests, and other agents' output outside the agent-visible repository and its history. Do not commit a task answer or hidden test to a branch in the same common repository.
6. Prebuild only that arm's permitted indexes. Ensure `zg` excludes evaluator files, injected usage cards, transcripts, this full specification, and index contents themselves. Trial agents receive the task and the appropriate short tool card, not this implementation handoff or the benchmark's answers.
7. Start a fresh OpenCode session. Never continue, fork, attach to, or reuse another arm's session.
8. After the run, validate that refs, corpus scope, and protected evaluation data stayed within the protocol. Grade the patch and answer outside the agent session.

Parallel implementation worktrees may share the development repository. Efficacy trials require the stronger separation above. The separate concurrency benchmark intentionally shares an index to test production behavior; it is not an efficacy trial.

Prevent network fetching of extra task evidence during trials while allowing the selected model endpoint. Disable browsing tools. Do not claim PATH changes alone are a security boundary: an unrestricted shell can find other binaries and files. Use the runner's available filesystem/tool restrictions and audit actual trajectories. If strong OS isolation is unavailable, disclose the protocol-level isolation and invalidate runs that access evaluator material or unavailable-arm artifacts.

An index-preparation error, provider outage, and a model's incorrect answer are different outcomes. Record them separately. A bug in Git Why during a treatment run is a treatment failure, not a free retry that disappears from the results. Predeclare at most one retry of an infrastructure-failed paired block, retaining both attempts; do not selectively rerun low-scoring arms. Report planned, attempted, valid, and successful counts so exclusions remain visible.

## 21. Free OpenCode models first; DevPass second

Run model discovery in the user's configured environment:

```sh
opencode --version
opencode models opencode --refresh --verbose
opencode run --help
```

OpenCode documents noninteractive execution, explicit `provider/model` IDs, raw JSON event output, and model discovery with cost metadata. Do not assume `opencode models --json` or an undocumented token-limit flag exists. [OpenCode CLI](https://opencode.ai/docs/cli/).

Select at most two actually available zero-priced candidates and run a tiny neutral calibration: read a file, make a trivial edit, run a test, and produce valid final output. Choose the faster reliable tool-using candidate before the pilot. Do not select the candidate by which one gives Git Why the largest improvement.

Free offerings change. For example, the documented catalog at drafting time includes MiMo-V2.5 Free and Nemotron 3.5 Lightning Free, but the runtime list and a successful real request determine what can be used. Record exact provider/model ID, timestamp, catalog price metadata, and whether a stable upstream model identity is disclosed. A stealth alias is not a verified upstream model. [OpenCode Zen](https://opencode.ai/docs/zen/).

Use synthetic or appropriately licensed public fixtures for these hosted evaluations. Free hosted inference is still remote inference, and some free model providers document collection of trial data. The local-only Git Why product and the separately hosted OpenCode experiment are distinct data flows. Do not feed a private work repository into a free-model benchmark by default.

Initial execution budget:

| Stage | Runs | Purpose |
| --- | --- | --- |
| Model calibration | At most 2 candidates × 2 neutral tasks | Confirm actual free availability and tool use. |
| Harness smoke | 4 tasks × 4 arms × 1 trial = 16 | Verify invocation, grading, isolation, and instrumentation. |
| Pilot | 8 frozen tasks × 4 arms × 2 fresh trials = 64 | First paired usefulness comparison. |
| Optional replication | Same pilot with one selected DevPass model | Check whether results survive a second model/provider. |
| Optional larger study | 20 tasks × 4 arms × 3 trials = 240 | Stronger evidence, after the pilot identifies a reason to expand. |

Smoke runs do not enter the pilot aggregate. Do not enlarge the study solely to find a positive result.

Start at **two concurrent OpenCode sessions total**, not two per arm. Randomize arm order within task/trial blocks and interleave arms so time-of-day/provider load does not systematically favor C. Increase concurrency only after observing stable rate limits and memory usage.

Default per-run budget: 8 minutes, 60 tool calls, and 12,000 generated tokens where the provider/harness exposes that limit. The runner enforces wall time and observed tool-call limits; token enforcement may have documented event-boundary overshoot. Record the actual limits that can be enforced. Retain aborted transcripts.

Set the initial benchmark's billed-model budget to zero. A rate limit does not authorize silently switching to a paid OpenCode model or an unknown metered endpoint. Once the free pilot is complete, DevPass can be used through the already configured, explicitly selected cheap/fast subscription route. Keep a separate cohort; do not mix providers halfway through an A/B/C/D block. Verify whether requests consume included quota or metered overage before choosing that route. Do not change the user's global default model or credential configuration.

If free endpoints are unavailable after one bounded retry, finish local/retrieval/performance work, save the provider error and resumption command, and mark the agent pilot blocked. A fabricated “representative result” is never an acceptable substitute.

## 22. OpenCode runner implementation

Implement a small Node runner invoking OpenCode with `spawn`/`execFile`, `shell: false`, an explicit working directory, and a fresh session:

```ts
spawn(opencodeExecutable, [
  "run",
  "--model", selectedModel,
  "--agent", "git-why-bench",
  "--format", "json",
  "--file", taskPromptPath,
  "Complete the attached task using the permitted repository."
], {
  cwd: trialWorktree,
  env: trialEnvironment,
  stdio: ["ignore", "pipe", "pipe"]
});
```

Create the named benchmark agent in the isolated profile first. Confirm these flags against installed help. The example specifies the invocation shape; it is not a claim that OpenCode emits one final JSON object. Its JSON mode emits events, and the runner must parse the installed version's event stream incrementally.

Capture stdout events, stderr, session ID, process exit, elapsed time, tool calls and outputs, final answer, token/cache/cost fields when available, and a clean final patch. Kill the entire child process group on timeout so tests and descendants do not leak into the next run.

Use a dedicated configuration profile and separate session/state location where supported. OpenCode's custom config is merged with other config sources; setting `OPENCODE_CONFIG` alone does not prove isolation. Inspect the effective profile, disable unrelated plugins/MCP, and verify no global instructions or past sessions leak into trials. Respect managed policies instead of attempting to bypass them. [OpenCode configuration precedence](https://opencode.ai/docs/config/).

Keep the same baseline profile across arms. An additional CLI's short usage card is the only arm-specific instruction difference. Avoid managed `zg install` modifying global agent instructions for just B/C; that would contaminate later A/D sessions. A separate realistic managed-integration experiment can be added later, with its configuration changes measured explicitly.

Prebuild indexes before the main warm-use pilot and measure preparation separately. `git why` uses `--no-refresh` in these frozen-history trials. `zg` uses the same explicit policy in B/C for noticing agent edits; charge any during-run refresh time to the run. Also execute a smaller fresh-install/first-use measurement so startup and index cost cannot disappear from the product story.

Log what the model actually did. Tool invocation alone is not evidence use: record whether returned evidence supported the final patch or cited rationale. Never force successful-tool-use examples into the published primary score while discarding runs that ignored the tool.

## 23. Agent scoring, costs, and claims

For every trial retain:

```text
task_id, task_stratum, arm, repetition, base_sha, corpus_fingerprint
implementation_sha, model_id, provider_id, model_metadata_timestamp
opencode_version, zg_version, git_version, runtime_version
profile_hash, prompt_hash, protocol_hash, dependency_lock_hash
pass, hidden_tests_passed, hidden_tests_total, evidence_grade
wall_ms, tool_calls, history_calls, zg_calls, git_why_calls
input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
actual_billed_cost, estimated_list_price_cost, tool_output_bytes
index_build_ms, model_download_ms, index_disk_bytes
exit_reason, infrastructure_error, treatment_error, invalidation_reason
```

Use `null` for unavailable usage or prices. Never report missing usage as zero. Preserve raw provider usage semantics; do not double-count cached tokens when a provider includes them in input totals. Distinguish actual zero-priced requests, subscription quota consumption, and an optional clearly labeled list-price estimate.

Report:

- Task success by stratum and arm, with numerator and denominator.
- Paired successes and failures: which specific tasks improved or regressed.
- Evidence accuracy and unsupported rationale claims.
- Tool adoption and whether the evidence was used correctly.
- Median wall time, tool calls, input/output tokens, and returned context bytes.
- All-attempt resource use and successful-only resource use, labeled separately. Fast incorrect runs are not efficiency wins.
- Preparation time and disk, in addition to agent-run time.

Use paired differences at the task level. Repetitions of one task are not independent new tasks. If presenting uncertainty, bootstrap by task cluster with its paired arms retained. An eight-task pilot is descriptive evidence with substantial uncertainty; do not attach a universal improvement percentage or claim statistical significance from the 64 individual runs as though they were 64 independent tasks.

Where quality is comparable, report “same success count, fewer tokens” as such. Do not call a nonsignificant quality difference proof of equivalence. A larger claim about equal quality needs a predefined acceptable margin and a larger study.

Useful outcomes include:

- Higher historical-task success with acceptable overhead.
- Similar success with less history exploration or smaller context.
- Strong retrieval but weak tool adoption, suggesting a usage-card problem.
- Helpful on history tasks and neutral/slower on current-code controls.
- No advantage over Git and FTS, suggesting the semantic layer has not yet earned its cost.

All are publishable. Positive results are not a condition of an honest benchmark report.

Include an amortization view only using measured quantities: preparation cost divided by per-task savings gives an approximate break-even task count when savings are positive and comparable. Keep time, bytes, and money in their own units. Free endpoints make latency, rate limits, and context use meaningful even when billed dollars are zero.

## 24. Benchmark C — CLI performance and parallel load

Use reproducible fixture sizes plus at least one pinned public repository when available. Record commits, records, paths, retained diff bytes, skipped bytes, and embedding tokens: commit count alone is a poor workload descriptor.

Measure these separately:

| Workload | Required observation |
| --- | --- |
| First use, missing model | Download, extraction, embedding, insertion, and total time. |
| First use, cached model | Initial build cost without network transfer. |
| Fresh CLI process, current index | Actual user-visible latency with process and model startup. |
| Loaded-process query loop | Inner retrieval overhead; clearly labeled diagnostic only. |
| One new ordinary commit | Freshness check, incremental embedding, and total query time. |
| Ten new commits | Batch throughput and peak memory. |
| Unchanged refs | No document re-embedding or rewrite; query embedding may still occur. |
| Rename/rebase/branch deletion | Correct counts, removals, and recovery costs. |
| 2/4/8 concurrent readers | Throughput, per-query p50/p95, failures, and aggregate memory. |
| Readers plus updater | Lock wait, eventual freshness, no corrupt or partial results. |
| Two simultaneous first uses | Single coherent index; no duplicate record inflation or model corruption. |

Take at least 30 measured warm-cache fresh-process queries after a documented warm-up for latency summaries. Report sample count and hardware. A “cold” process is not automatically a cold OS page cache; use precise labels and do not require privileged cache eviction.

Break down end-to-end timing into repository detection, fingerprint, lock waiting, refresh, model load, query embedding, lexical/vector retrieval, grouping/fetch, and rendering. The sum should reconcile with total time within instrumentation overhead.

Initial targets, not current results or unconditional release promises:

- Inner loaded-process retrieval p95 under 150 ms on the reference corpus.
- Warm-cache fresh-process CLI p95 under 1 second on that corpus.
- One small incremental commit plus query within 3 seconds on the reference hardware.
- A 10k-commit representative corpus index in minutes, with exact record/input counts disclosed.
- Ordinary index size in the hundreds-of-MB range; publish actual bytes per record and model cache separately.
- Peak memory compatible with a development laptop, including the aggregate eight-reader result.

If the fresh-process CLI is slow while the inner search is fast, optimize model loading, text construction, or metadata work. Do not hide the problem by introducing an unrequested daemon or reporting only the database's advertised latency.

## 25. Repository structure

Keep the runtime modules small and explicit. A suitable layout is:

| Directory | Responsibility |
| --- | --- |
| `src/cli/` | Arguments, command dispatch, exit handling. |
| `src/git/` | Repository identity, ref snapshots, Git process execution, metadata/patch parsing. |
| `src/history/` | Records, text construction, chunking, exclusion/coverage policy. |
| `src/embedding/` | One local production embedder and artifact cache. |
| `src/index/` | Zvec adapter, manifest/catalog, locks, journal, refresh/rebuild/gc. |
| `src/search/` | Typed filters, branches, commit collapse, RRF, evidence selection. |
| `src/output/` | Human rendering and versioned JSON schema. |
| `test/` | Unit, real-Git integration, native storage, lifecycle, and installed-package tests. |
| `scripts/` | Doctor, packaging verification, public-repository setup. |
| `bench/` | Frozen protocol, generators, retrieval runner, OpenCode adapter, scoring/reporting. |
| `docs/` | Decisions, operational contract, limitations, benchmark methodology/results. |

No DI framework, workflow engine, event bus, generic corpus abstraction, or plugin system. Public boundaries are extraction → records, records → storage, query → structured results, results → rendering.

Development dependencies should not load when someone runs `git why`. OpenCode, `zg`, Python references used in a spike, and benchmark plotting tools are not product runtime requirements.

## 26. mise, package, and public GitHub repository

Use mise as the development entry point and npm as the package manager. Prefer Node 24 for the pinned development runtime, with the minimum supported Node version determined by actual dependency and package tests. The original Node 22+ goal is acceptable only when the installed package passes on Node 22 too.

Bootstrap by resolving and pinning real available versions, for example:

```sh
mise use --pin node@24
mise use --pin gh@latest
mise install
```

Commit the resulting exact versions in `mise.toml` and the supported mise lockfile. Do not leave `latest` as the reproducibility contract. Preserve an existing usable OpenCode installation and its DevPass configuration; record its exact version in benchmark metadata. If installing a separate benchmark version, pin it and avoid changing the global provider setup.

Required mise tasks, backed by ordinary scripts:

| Task | Behavior |
| --- | --- |
| `setup` | Install npm dependencies from the lockfile and run doctor. |
| `doctor` | Verify tools, native dependencies, Git capabilities, and optional benchmark prerequisites. |
| `build` | Compile the package. |
| `check` | Formatting/lint/type checks and required functional tests. |
| `test:integration` | Real repositories, storage, locks, recovery, and edge cases. |
| `test:package` | Pack, install in a clean prefix, and invoke through Git. |
| `spike:capabilities` | Execute dependency and runtime probes. |
| `bench:retrieval` | Run the frozen retrieval comparison. |
| `bench:perf` | Run the bounded CLI/system measurements. |
| `bench:agents:smoke` | Run the 16 free-model smoke trials. |
| `bench:agents:pilot` | Run the 64 free-model pilot trials. |
| `bench:report` | Generate tables and the report from saved records. |
| `repo:create` | Idempotently create/verify and push the authorized public repository. |

Declare task dependencies accurately. mise may run sibling prerequisites in parallel; listing them in a particular order is not a sequence. Build-before-package-test must be an explicit dependency or sequential script. [mise tasks](https://mise.jdx.dev/tasks/).

Package requirements:

- `package.json` exposes `bin: { "git-why": "dist/cli/main.js" }`.
- Preserve an executable Node shebang and executable file mode in the tarball.
- Compile before packing; include built JS, README, license, and needed schema files.
- Exclude credentials, test repositories, transcripts, benchmark caches, indexes, model weights, and development worktrees from the tarball.
- Verify `npm pack`, installation into a temporary prefix, direct `git-why`, and discovery as `git why` from a different directory.
- Check npm name availability before advertising `npm install -g git-why`. If unavailable, choose a verified appropriate scope and keep the executable name unchanged.
- Use Apache-2.0 for the new project unless the existing repository specifies another compatible license; preserve all borrowed notices and model licenses.

### Public repository creation is a deliverable

Resolve the active GitHub identity with the available authenticated GitHub tooling; with `gh`, inspect `gh auth status` and `gh api user --jq .login` without printing tokens. Use that authenticated personal namespace unless the user already supplied a specific owner. Do not infer an organization from the user's employer.

Preferred repository: `<authenticated-login>/git-why`.

If it already exists, inspect it. Reuse it only when it is clearly this project. Never overwrite an unrelated repository or force-push to make creation look successful. An unrelated name collision can use `git-why-cli` while preserving the Git Why brand and executable; document the actual URL.

Create a concrete local repository first, with README, license, this spec, mise setup, and buildable scaffold. Then create the public remote and push the reviewed project files. Continue pushing coherent implementation and report commits as work finishes. The CLI supports creation from a local source and pushing it to a new public remote. [GitHub CLI repository creation](https://cli.github.com/manual/gh_repo_create).

Equivalent invocation shape, run with validated structured arguments:

```sh
gh repo create OWNER/git-why --public --source=. --remote=origin --push \
  --description "Semantic archaeology for Git. Find the history that explains the code."
```

`OWNER` is resolved at execution time, not a literal account name. If publishing fails after creation, inspect remote state and resume; do not blindly create another repository.

Before pushing, inspect the exact staged file list and diff for accidental credentials, local provider configuration, private corpora, and raw secret-bearing logs. Publish synthetic/public benchmark artifacts and sanitized configuration fingerprints. Keep any supported raw event format necessary for reproducibility after redaction.

Finish by verifying the remote is public, its default branch includes the intended implementation/report commit, and a clean clone can run the documented setup and package smoke. A successfully printed `gh` command is not evidence that those postconditions hold.

## 27. Parallel implementation and measurement plan

Land the core record, search-result, and storage-boundary contracts before fanning out implementation. Use separate development worktrees and branches; assign exclusive module ownership while changes are in flight.

| Lane | Independent responsibility |
| --- | --- |
| Git/history | Git fixtures, byte-safe parsing, metadata, chunking, coverage. |
| Storage | Zvec schema adapter, locks, catalog/journal, refresh/rebuild. |
| Retrieval | Embedder, text representations, branch search and commit ranking. |
| CLI | Argument contract, human/JSON output, package tests. |
| Evaluation | Fixture protocol, runner, hidden graders, reporting. |

One integrator owns shared dependency changes and the lockfile. Merge or cherry-pick completed branches in dependency order, resolve conflicts, and run meaningful integration checks. Do not ask several workers to rewrite the same manifest or run `npm install` in the same checkout.

The benchmark trial models are the actual cheap/free OpenCode agents. Do not substitute a stronger orchestration model's answers and label them OpenCode results. The orchestrator can build and audit the harness; it does not solve the trial task on behalf of a failing model.

Run native integration and parser tests while model calibration proceeds if they do not contend for the same measured hardware resources. Do not run CPU-heavy indexing jobs during latency measurements unless the run is explicitly the contention benchmark.

## 28. Milestones with concrete exit gates

### M0 — repository and capability proof

Create the repository setup and public remote; execute native binding, locking, and local embedding probes. Capture dependency identities and a small real-Git fixture. Run the first free-model calibration if the provider is available.

**Exit:** the chosen runtime can actually store, reopen, filter, retrieve, and safely coordinate access; the selected model can actually run locally. Blockers are explicit.

### M1 — complete vertical slice

Implement extraction, initial index, hybrid search, commit grouping, human output, and JSON together. The command works as `git why` from an installed package. Start with correct behavior and bounded data, not colors.

**Exit:** a clean temporary installation finds the expected evidence in a deterministic fixture, including deleted code and a poor-message/rich-diff case. JSON is usable by the real OpenCode smoke adapter.

### M2 — lifecycle correctness

Implement incremental refresh, snapshot scope, worktrees, journal recovery, exclusive updates/shared reads, status, rebuild, GC, and incomplete-history reporting.

**Exit:** concurrent real processes and injected termination cannot publish mixed metadata or corrupt the collection; failed rebuilds preserve the previous usable generation.

### M3 — bounded retrieval quality

Execute the three-candidate development comparison, summaries-only ablation, filters, noise policies, and pathological-commit handling. Freeze the selected model, extraction representation, ranking, and benchmark protocol.

**Exit:** raw development and held-out results exist, and the report explains exact/synonym, lifecycle, and failure cases. No tuned-on-test success claim.

### M4 — real OpenCode pilot

Execute smoke, then the paired eight-task pilot on a verified free model with isolated histories and fresh sessions. Produce objective test results, evidence grades, transcripts, and resource data. Run a DevPass replication only through a selected suitable route and a separate cohort.

**Exit:** the report answers whether the tool was found, used, helpful, costly, or ignored. A negative effect still satisfies honest evaluation; infrastructure failure does not count as an executed pilot.

### M5 — operational and public release readiness

Execute CLI performance, parallel load, package installation, documented OS/runtime checks, and the clean-clone path. Produce a concise README demo and finish the public repository with the implementation and report.

**Exit:** all claimed support and measurements have evidence. The final handoff distinguishes working, measured, unsupported, and externally blocked items.

## 29. Required acceptance matrix

Use actual repositories and native bindings for the risks below. Unit tests with small fake vectors are useful for ranking and parsing, but cannot replace these checks.

| Area | Required acceptance |
| --- | --- |
| Installation | `git why` works after tarball install outside the source checkout; help/version work without model or index. |
| Empty/bare/subdirectory | Sensible behavior, correct common-dir resolution, no unnecessary model download. |
| Parsing | Root, deletion, rename-only, mode-only, binary, CRLF, no trailing newline, merge metadata. |
| Paths | Spaces, quotes, tabs, newline, leading dash, non-ASCII; non-UTF-8 identity preservation where supported. |
| Git object format | SHA-1 and SHA-256 fixtures; no hard-coded hash length or empty-tree object ID. |
| Attribute/config stability | The same commit extracts identically across worktrees and unrelated user diff settings. |
| Scope | Branches, tags, remotes, detached sibling HEAD; exclude stash/reflog/notes/replace refs. |
| Shallow/partial | Missing ancestors do not become roots; no implicit fetch; deepening retries affected evidence. |
| Incremental | No document re-embedding for unchanged scope; new commits indexed once; stale records removed correctly. |
| Filtering | Applied before selection; summaries and matching hunks remain consistent; path/author/date combinations. |
| Ranking | Five results mean five commits; huge commits do not win by duplicate-message count. |
| Source integrity | Display excerpts and coordinates verify against Git; normalization never overwrites evidence. |
| Crash recovery | Terminate before insert, mid-batch, after collection checkpoint, during metadata publication, and during rebuild switch. |
| Concurrent access | Multiple independent reader processes; two updaters; simultaneous first build; writer termination. |
| Output | JSON-only stdout, bounded valid output, no vectors, control-sequence sanitation, NO_COLOR, EPIPE, interruption. |
| Privacy/offline | Cached-model use with network blocked; downloads contain no repository content; Git does not fetch. |
| Resource bounds | Oversized patch, long commit message, generated import, duplicate hunks, and bounded model threads. |
| Agent harness | No future-fix objects, no leaked labels, same model/budgets, no global-config contamination, fresh sessions. |
| Public handoff | Remote is public; correct code/report SHA is pushed; clean-clone instructions work. |

For extraction stability, use the historical commit's attributes where the Git version supports an explicit attribute source, disable global/system attribute overrides, and test the result. Working-tree `.gitattributes` must not change the record identity or evidence for an already indexed immutable commit. If a needed Git capability is unavailable, doctor must say so instead of silently changing semantics.

The release gate is functional correctness and complete, honest evaluation. A claim that Git Why improves coding agents is a separate claim that only the measurements can support. Do not gate publication of the project on obtaining favorable numbers.

## 30. README and report requirements

README opens with the name, one-line pitch, and a real terminal example. Then installation and three useful queries. A user should see the product before reading about vector storage.

Keep the first screen concise. Later sections explain model download/offline use, indexing location, history scope, `--no-refresh`, filters, worktree behavior, supported platforms, and limitations. Include a brief “When to use ordinary Git instead” note: known exact strings, exhaustive searches, and causal verification still benefit from Git's native tools.

The benchmark report includes:

1. The frozen question and protocol, including limits and dataset provenance.
2. Environment, pinned models/tools, and corpus snapshots.
3. Retrieval-quality table with per-query data available.
4. A/B/C/D agent results, task-level successes/regressions, and evidence-use analysis.
5. CLI latency, first-index cost, memory, disk, and parallel behavior.
6. Failure examples and limitations, including small sample size or missing real-repository checks.
7. Exact commands to reproduce and the code commit used for each run.

Generate tables from raw results, not hand-entered percentages. Prefer a few clear tables over a dashboard. Do not commit model weights or full upstream repositories merely to make a report look reproducible; commit generators, licenses, checksums, pinned sources, and compact results.

## 31. V1 release bar

V1 is complete when:

- It installs and runs as `git why` with no alias setup.
- It is local by default and uses Zvec for history retrieval.
- Messages, useful diffs, deleted code, and file-change metadata are searchable.
- Hybrid retrieval and accurate filters return distinct commits with verifiable excerpts.
- First-use indexing, incremental refresh, worktrees, shallow boundaries, rebuilds, and interrupted operations behave as specified.
- Supported concurrent-reader and exclusive-writer behavior has been tested in real processes.
- JSON is stable, compact, and clean enough for an ordinary coding-agent shell call.
- The retrieval suite, performance measurements, and free-model OpenCode pilot were actually executed.
- The public repository contains code, setup, documentation, reproducible fixtures, and the benchmark report.

An unavailable provider or publishing credential leaves the corresponding gate blocked. A completed local tool can still be handed off or pushed as a preview while preserving the outstanding gate; do not label that gate passed or call the evaluated V1 release complete. Do not claim an untested platform, an unpublished npm package name, a runtime performance target, or a positive agent effect as established fact.

## 32. Future work stays small until evidence says otherwise

V1.1 candidates are line-context queries, stdin diff queries, an indexed-evidence inspection command, explicit revision restriction, and better merge-resolution evidence. None are needed to finish V1. Any future line-context feature reads current source to construct a query; that is an intentional new feature, not a hidden V1 corpus expansion.

V2 can ask one question of two independent corpora:

| Evidence channel | Owner | Question |
| --- | --- | --- |
| Past | Git Why | What changed, what was removed, and what explanation was committed? |
| Present | Zvec-Grep | Where does the relevant behavior live now? |

Retrieve independently, preserve provenance and each corpus's freshness, then present a combined view with visible past/present labels. Benchmark arm C is an early experiment in whether this combination is useful, without committing to a V2 integration architecture.

Do not merge history and workspace records into a single undifferentiated ranking. A relevant old path is not proof that a similarly named current function is its descendant. Mapping the two requires evidence.

PR discussion ingestion comes after a strong local history tool and introduces forge identity, network/auth, permission, retention, and commit-linking decisions. CI logs are a later separate workload. Graphs require concrete unanswered queries before they earn a place in the design.

Keep the product's final check simple:

> Would Git Why still be useful if V2 never existed?

The answer must be yes. Ship the small tool, measure the actual benefit, and let the results earn the next feature.
