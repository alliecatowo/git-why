import assert from 'node:assert/strict';
import test from 'node:test';
import { expandStructuralCandidates, LINK_HOP_DISCOUNT } from '../../../src/search/expand.js';
import type { LineageStore } from '../../../src/types.js';

const lineage: LineageStore = {
  lookupToken: async () => null,
  lookupPath: async () => null,
  linkedCommits: async (sha) =>
    sha === 'seed'
      ? new Map([
          ['origin', 1],
          ['far', 2],
        ])
      : new Map(),
  diskBytes: async () => 0,
  close: async () => {},
};

test('structural expansion adds only lineage links with a hop discount', async () => {
  const expanded = await expandStructuralCandidates(
    [{ sha: 'seed', score: 1, matchedBy: ['semantic'] }],
    lineage,
    12,
    2,
  );
  assert.deepEqual(
    expanded.map((item) => item.sha),
    ['seed', 'origin', 'far'],
  );
  assert.equal(expanded[1]?.score, LINK_HOP_DISCOUNT);
  assert.equal(expanded[2]?.score, LINK_HOP_DISCOUNT ** 2);
  assert.deepEqual(expanded[1]?.matchedBy, ['linked']);
});

test('existing direct candidates are never downgraded by a structural link', async () => {
  const expanded = await expandStructuralCandidates(
    [
      { sha: 'seed', score: 1, matchedBy: ['semantic'] },
      { sha: 'origin', score: 0.9, matchedBy: ['text'] },
    ],
    lineage,
  );
  assert.equal(expanded.find((item) => item.sha === 'origin')?.score, 0.9);
  assert.deepEqual(expanded.find((item) => item.sha === 'origin')?.matchedBy, ['text']);
});
