/**
 * Repository identity: never assume `.git` is a directory, always resolve the
 * canonical common directory so every worktree of the same repository agrees on
 * index/lock paths, and refuse legacy grafts outright (spec #6).
 */

import { realpath, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GitWhyError, type ObjectFormat, type RepositoryIdentity } from '../types.js';
import { runGitDiscovery } from './exec.js';

/** Resolve repository identity starting from any directory inside or at a repository. */
export async function resolveRepositoryIdentity(startDir: string): Promise<RepositoryIdentity> {
  const result = await runGitDiscovery(startDir, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
    '--git-dir',
    '--is-bare-repository',
    '--show-object-format=storage',
    '--is-shallow-repository',
  ]);
  if (result.code !== 0) {
    throw new GitWhyError('NO_REPOSITORY', `not a git repository (or any parent): ${startDir}`, {
      hint: result.stderr.toString('utf8').trim(),
    });
  }
  const lines = result.stdout.toString('utf8').trim().split('\n');
  const [commonDirRaw, , isBareRaw, objectFormatRaw, isShallowRaw] = lines;
  if (
    commonDirRaw === undefined ||
    isBareRaw === undefined ||
    objectFormatRaw === undefined ||
    isShallowRaw === undefined
  ) {
    throw new GitWhyError('NO_REPOSITORY', `could not parse repository identity for: ${startDir}`);
  }

  const commonDir = await realpath(commonDirRaw);
  const isBare = isBareRaw.trim() === 'true';
  const isShallow = isShallowRaw.trim() === 'true';
  const objectFormat = parseObjectFormat(objectFormatRaw.trim());

  await rejectLegacyGrafts(commonDir);

  let worktreeRoot: string | null = null;
  if (!isBare) {
    const topLevel = await runGitDiscovery(startDir, [
      'rev-parse',
      '--path-format=absolute',
      '--show-toplevel',
    ]);
    if (topLevel.code === 0) {
      const top = topLevel.stdout.toString('utf8').trim();
      if (top.length > 0) worktreeRoot = await realpath(top);
    }
  }

  return {
    commonDir,
    worktreeRoot,
    isBare,
    isShallow,
    objectFormat,
    stateDir: join(commonDir, 'why'),
  };
}

function parseObjectFormat(raw: string): ObjectFormat {
  if (raw === 'sha1' || raw === 'sha256') return raw;
  throw new GitWhyError('INTERNAL', `unrecognised Git object format: ${raw}`);
}

/**
 * Legacy `.git/info/grafts` silently rewrites parentage and is incompatible with
 * treating commits as immutable. Modern replace refs are handled instead by disabling
 * replace-object interpretation for every invocation (see `exec.ts`); this only
 * rejects the legacy graft file, and never touches `safe.directory`.
 */
async function rejectLegacyGrafts(commonDir: string): Promise<void> {
  try {
    const contents = await readFile(join(commonDir, 'info', 'grafts'), 'utf8');
    if (contents.trim().length > 0) {
      throw new GitWhyError(
        'UNSUPPORTED_HISTORY_OVERRIDE',
        'this repository uses legacy Git grafts (.git/info/grafts), which silently rewrite commit ancestry',
        {
          hint: 'remove the grafts file (after converting it with `git filter-repo` or similar) to use git-why',
        },
      );
    }
  } catch (error) {
    if (error instanceof GitWhyError) throw error;
    // ENOENT (no grafts file) is the expected, common case.
  }
}

/** Contents of `<commonDir>/shallow`, one OID per line, sorted. Empty for a complete clone. */
export async function readShallowBoundary(commonDir: string): Promise<string[]> {
  try {
    const contents = await readFile(join(commonDir, 'shallow'), 'utf8');
    return contents
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .sort();
  } catch {
    return [];
  }
}
