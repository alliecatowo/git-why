/**
 * Attribute/config stability acceptance row (spec #29): the same immutable commit
 * must extract identically regardless of a working-tree `.gitattributes` file or
 * unrelated user diff settings. This machine's installed Git does not support
 * `--attr-source` (probed in `src/git/exec.ts`), so the mitigation here is
 * structural: every diff-tree invocation runs with `cwd` set to the common
 * directory and an explicit `--git-dir`, never inside a worktree, which this
 * project's own probing showed stops Git from consulting the worktree's
 * `.gitattributes` at all for historical commits.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGitHistoryExtractor } from '../../../src/git/extract.js';
import { resolveRepositoryIdentity } from '../../../src/git/repository.js';
import { captureSnapshot } from '../../../src/git/snapshot.js';
import { createTestRepo } from '../../fixtures/repo.js';
import type { CommitExtraction } from '../../../src/types.js';

async function extractOne(dir: string, sha: string): Promise<CommitExtraction> {
  const repository = await resolveRepositoryIdentity(dir);
  const snapshot = await captureSnapshot(repository);
  const extractor = createGitHistoryExtractor();
  for await (const item of extractor.extract(snapshot, [sha])) return item;
  throw new Error('no result');
}

test('a working-tree .gitattributes does not change an already-committed commit\'s extraction', async () => {
  const repo = await createTestRepo();
  try {
    await repo.writeFile('data.bin', 'line one\nline two\n');
    await repo.add(['data.bin']);
    await repo.commit('add data.bin');
    await repo.writeFile('data.bin', 'line one\nline two changed\n');
    await repo.add(['data.bin']);
    const sha = await repo.commit('change data.bin');

    const baseline = await extractOne(repo.dir, sha);
    const baselineEvidence = baseline.evidence.find((e) => e.path.display === 'data.bin');
    assert.ok(baselineEvidence);
    assert.equal(baselineEvidence.kind, 'hunk', 'baseline: plain text change produces a hunk, not a binary file_change');

    // Add an UNTRACKED worktree .gitattributes marking the file as binary. This is
    // exactly the working-tree state a user could have checked out locally; it must
    // not change the record for an already-committed, immutable commit.
    await repo.writeFile('.gitattributes', '*.bin binary\n');

    const withAttrs = await extractOne(repo.dir, sha);
    const withAttrsEvidence = withAttrs.evidence.find((e) => e.path.display === 'data.bin');
    assert.ok(withAttrsEvidence);
    assert.equal(withAttrsEvidence.kind, 'hunk', 'a worktree .gitattributes must not turn this into a binary file_change');
    assert.deepEqual(withAttrsEvidence.sourceExcerpt, baselineEvidence.sourceExcerpt);
    assert.deepEqual(withAttrs.commit.coverage, baseline.commit.coverage);
  } finally {
    await repo.cleanup();
  }
});

test('unrelated local diff config (algorithm, color, pager, external diff) does not change extraction', async () => {
  const repo = await createTestRepo();
  try {
    await repo.writeFile('f.txt', 'alpha\nbeta\ngamma\n');
    await repo.add(['f.txt']);
    await repo.commit('add f.txt');
    await repo.writeFile('f.txt', 'alpha\nBETA\ngamma\n');
    await repo.add(['f.txt']);
    const sha = await repo.commit('change f.txt');

    const baseline = await extractOne(repo.dir, sha);

    // Disruptive local repo config: a different diff algorithm than our fixed policy,
    // forced color, an external diff driver that would corrupt output if honoured,
    // and a pager that would hang or break output if honoured.
    await repo.gitOrThrow(['config', 'diff.algorithm', 'patience']);
    await repo.gitOrThrow(['config', 'color.diff', 'always']);
    await repo.gitOrThrow(['config', 'color.ui', 'always']);
    await repo.gitOrThrow(['config', 'diff.external', '/bin/false']);
    await repo.gitOrThrow(['config', 'core.pager', '/bin/false']);

    const withConfig = await extractOne(repo.dir, sha);

    assert.deepEqual(withConfig.commit.changedPaths, baseline.commit.changedPaths);
    assert.deepEqual(
      withConfig.evidence.map((e) => e.sourceExcerpt),
      baseline.evidence.map((e) => e.sourceExcerpt),
    );
    // Forced color must not leak ANSI escape codes into stored evidence.
    for (const e of withConfig.evidence) {
      assert.ok(!e.sourceExcerpt.includes('\x1b['), 'no ANSI color codes in stored evidence');
    }
  } finally {
    await repo.cleanup();
  }
});
