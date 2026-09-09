/**
 * Capture a `RepositorySnapshot`: local branch tips, remote-tracking tips, tags that
 * peel to a commit, and the HEAD of every registered worktree (spec #6). Tips are
 * captured once, deduplicated and sorted; nothing here re-resolves a moving ref name
 * later in the same refresh — callers must hold onto `tipOids` and pass them to
 * `enumerateReachable` instead of re-querying refs.
 */

import { createHash } from 'node:crypto';
import {
  EXTRACTION_POLICY_VERSION,
  type RefTip,
  type RepositoryIdentity,
  type RepositorySnapshot,
} from '../types.js';
import { probeGitCapabilities, runGit } from './exec.js';
import { extractionConfigFingerprint } from './policy.js';
import { readShallowBoundary } from './repository.js';

/** ASCII unit separator; refnames/OIDs/object types never contain it. */
const FIELD_SEP = '\x1f';

async function listRefTips(repository: RepositoryIdentity): Promise<RefTip[]> {
  // One batched call for branches, remote-tracking branches and tags. `%(*objectname)`
  // and `%(*objecttype)` are empty unless the ref is an annotated tag, giving us the
  // peeled target for free without a second pass per tag. Git terminates each record
  // with its own `\n`, so splitting on that needs no extra record marker.
  const format = [
    '%(refname)',
    '%(objectname)',
    '%(objecttype)',
    '%(*objectname)',
    '%(*objecttype)',
  ].join(FIELD_SEP);
  const result = await runGit({
    gitDir: repository.commonDir,
    cwd: repository.commonDir,
    args: ['for-each-ref', `--format=${format}`, 'refs/heads', 'refs/remotes', 'refs/tags'],
  });
  if (result.code !== 0) {
    throw new Error(`git for-each-ref failed: ${result.stderr.toString('utf8').trim()}`);
  }
  const text = result.stdout.toString('utf8');
  const tips: RefTip[] = [];
  for (const record of text.split('\n')) {
    if (record.trim().length === 0) continue;
    const fields = record.split(FIELD_SEP);
    const refname = fields[0];
    const objectname = fields[1];
    const objecttype = fields[2];
    const peeledName = fields[3];
    const peeledType = fields[4];
    if (refname === undefined || objectname === undefined || objecttype === undefined) continue;
    if (objecttype === 'tag') {
      // Only tags that peel to a commit are in scope; a tag of a blob/tree is excluded.
      if (peeledType === 'commit' && peeledName !== undefined && peeledName.length > 0) {
        tips.push({ name: refname, oid: peeledName });
      }
      continue;
    }
    if (objecttype === 'commit') {
      tips.push({ name: refname, oid: objectname });
    }
  }
  return tips;
}

interface WorktreeEnumeration {
  readonly tips: RefTip[];
  readonly complete: boolean;
}

async function listWorktreeHeads(repository: RepositoryIdentity): Promise<WorktreeEnumeration> {
  const result = await runGit({
    gitDir: repository.commonDir,
    cwd: repository.commonDir,
    args: ['worktree', 'list', '--porcelain'],
  });
  if (result.code !== 0) {
    // Failure to enumerate registered worktrees at all: incomplete, but not fatal.
    return { tips: [], complete: false };
  }
  const text = result.stdout.toString('utf8');
  const blocks = text.split(/\n\n+/);
  const tips: RefTip[] = [];
  let complete = true;
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.length > 0);
    if (lines.length === 0) continue;
    const worktreeLine = lines.find((l) => l.startsWith('worktree '));
    if (worktreeLine === undefined) continue;
    const path = worktreeLine.slice('worktree '.length);
    if (lines.some((l) => l.startsWith('prunable'))) {
      // Registered but no longer accessible: this is exactly the "temporarily
      // inaccessible worktree" case, which must not silently drop history eligibility.
      complete = false;
      continue;
    }
    const headLine = lines.find((l) => l.startsWith('HEAD '));
    if (headLine === undefined) {
      // Unborn branch (no commits yet) — nothing to add, not a failure.
      continue;
    }
    const oid = headLine.slice('HEAD '.length);
    tips.push({ name: `worktree:${path}:HEAD`, oid });
  }
  return { tips, complete };
}

function dedupeSortTips(tips: readonly RefTip[]): RefTip[] {
  const byKey = new Map<string, RefTip>();
  for (const tip of tips) byKey.set(`${tip.name} ${tip.oid}`, tip);
  return [...byKey.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function dedupeSortOids(tips: readonly RefTip[]): string[] {
  return [...new Set(tips.map((t) => t.oid))].sort();
}

function computeFingerprint(
  tips: readonly RefTip[],
  shallowBoundary: readonly string[],
  objectFormat: string,
  configFingerprint: string,
): string {
  const payload = JSON.stringify({
    tips: tips.map((t) => `${t.name} ${t.oid}`),
    shallowBoundary,
    objectFormat,
    extractionPolicyVersion: EXTRACTION_POLICY_VERSION,
    gitExtractionConfigFingerprint: configFingerprint,
  });
  return createHash('sha256').update(payload).digest('hex');
}

/** Capture the repository snapshot once at the start of a reconciliation. */
export async function captureSnapshot(repository: RepositoryIdentity): Promise<RepositorySnapshot> {
  const caps = await probeGitCapabilities();
  const [refTips, worktrees, shallowBoundary] = await Promise.all([
    listRefTips(repository),
    listWorktreeHeads(repository),
    readShallowBoundary(repository.commonDir),
  ]);

  const tips = dedupeSortTips([...refTips, ...worktrees.tips]);
  const tipOids = dedupeSortOids(tips);
  const configFingerprint = extractionConfigFingerprint(caps);
  const fingerprint = computeFingerprint(
    tips,
    shallowBoundary,
    repository.objectFormat,
    configFingerprint,
  );

  return {
    repository,
    tips,
    tipOids,
    shallowBoundary,
    fingerprint,
    complete: worktrees.complete,
    capturedAt: Date.now(),
    scope: 'branches-remotes-tags-worktree-heads',
  };
}
