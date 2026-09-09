/**
 * Proves the git <-> history join (the seam this module exists to fix): git's
 * structural extraction must be routed through `buildCommitExtraction`
 * (`src/history/extract.ts`), not bypass it. A record that reaches storage with
 * a placeholder, non-hashed id, or with empty `semanticText`/`lexicalText`, means
 * a retrieval branch is dead.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGitHistoryExtractor } from '../../../src/git/extract.js';
import { resolveRepositoryIdentity } from '../../../src/git/repository.js';
import { captureSnapshot } from '../../../src/git/snapshot.js';
import { createTestRepo } from '../../fixtures/repo.js';
import { FakeEmbedder } from '../../../src/embedding/fake.js';
import type { CommitExtraction } from '../../../src/types.js';

const HEX_64 = /^[0-9a-f]{64}$/;

async function extractAll(
  dir: string,
  shas: readonly string[],
): Promise<Map<string, CommitExtraction>> {
  const repository = await resolveRepositoryIdentity(dir);
  const snapshot = await captureSnapshot(repository);
  const extractor = createGitHistoryExtractor(new FakeEmbedder());
  const out = new Map<string, CommitExtraction>();
  for await (const item of extractor.extract(snapshot, shas)) {
    out.set(item.commit.sha, item);
  }
  return out;
}

test('git extraction is routed through buildCommitExtraction: real ids, populated text, merged coverage', async () => {
  const repo = await createTestRepo();
  try {
    // --- a plain commit: deterministic ids and populated semantic/lexical text ---
    await repo.writeFile('src/a.ts', 'function original() {\n  return 1\n}\n');
    await repo.add(['src/a.ts']);
    await repo.commit('add a.ts');
    await repo.writeFile('src/a.ts', 'function original() {\n  return 2\n}\n');
    await repo.add(['src/a.ts']);
    const sha = await repo.commit('change return value in a.ts');

    // --- a merge commit: exercises git-discovered coverage (merge_hunks_omitted) ---
    await repo.writeFile('base.txt', 'base\n');
    await repo.add(['base.txt']);
    await repo.commit('base commit');
    const mainBranch = await repo.currentBranch();
    await repo.gitOrThrow(['checkout', '-q', '-b', 'feature']);
    await repo.writeFile('feature.txt', 'feature\n');
    await repo.add(['feature.txt']);
    await repo.commit('feature commit');
    await repo.gitOrThrow(['checkout', '-q', mainBranch]);
    await repo.writeFile('main-side.txt', 'main side\n');
    await repo.add(['main-side.txt']);
    await repo.commit('main side commit');
    const mergeResult = await repo.git([
      'merge',
      '-q',
      '--no-ff',
      'feature',
      '-m',
      'merge feature',
    ]);
    assert.equal(mergeResult.code, 0, mergeResult.stderr);
    const mergeSha = await repo.head();

    const results = await extractAll(repo.dir, [sha, mergeSha]);

    const extraction = results.get(sha);
    assert.ok(extraction);

    // Ids are deterministic 64-hex-character SHA-256 digests, never the old
    // placeholder `commit:<sha>` / `<kind>:<sha>:...` shapes.
    assert.match(extraction.commit.id, HEX_64);
    assert.doesNotMatch(extraction.commit.id, /^commit:/);

    const hunk = extraction.evidence.find((e) => e.kind === 'hunk');
    assert.ok(hunk, 'expected a hunk evidence record for a plain text change');
    assert.match(hunk.id, HEX_64);
    assert.doesNotMatch(hunk.id, /^hunk:/);

    // Populated by buildCommitExtraction; the git lane never fills these in itself.
    assert.ok(extraction.commit.semanticText.length > 0, 'commit semanticText must not be empty');
    assert.ok(extraction.commit.lexicalText.length > 0, 'commit lexicalText must not be empty');
    assert.ok(hunk.semanticText.length > 0, 'hunk semanticText must not be empty');
    assert.ok(hunk.lexicalText.length > 0, 'hunk lexicalText must not be empty');
    assert.ok(hunk.semanticText.includes('Removed code'));
    assert.ok(hunk.semanticText.includes('Added code'));

    // A git-discovered coverage reason (merge_hunks_omitted) must survive the join
    // into the final CommitRecord.coverage, merged in by buildCommitExtraction.
    const mergeExtraction = results.get(mergeSha);
    assert.ok(mergeExtraction);
    assert.match(mergeExtraction.commit.id, HEX_64);
    assert.ok(mergeExtraction.commit.coverage.reasons.includes('merge_hunks_omitted'));
    assert.equal(mergeExtraction.commit.coverage.complete, false);
    assert.equal(mergeExtraction.evidence.length, 0, 'no merge diff hunks in V1');
    // The merge's own message-derived semantic text must still be populated, even
    // though no per-file evidence was produced.
    assert.ok(mergeExtraction.commit.semanticText.length > 0);
    // changedPaths (first-parent) must survive despite files being omitted for evidence purposes.
    assert.deepEqual(
      mergeExtraction.commit.changedPaths.map((c) => c.path.display),
      ['feature.txt'],
    );
  } finally {
    await repo.cleanup();
  }
});
