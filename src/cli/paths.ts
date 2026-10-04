/**
 * Resolves the raw `-- <path>...` tokens captured by `args.ts` into
 * repository-relative `PathRestriction`s. Kept separate from `args.ts`
 * because it needs the repository root, known only after a repository is
 * opened, and separate from the git lane because it is plain path
 * arithmetic — no Git process invocation is needed.
 */

import * as path from 'node:path';
import { GitWhyError, type PathRestriction } from '../types.js';

/**
 * Glob wildcards and leading-colon pathspec magic, which we do not implement. Brackets and
 * braces are ordinary characters in real paths (Next.js/SvelteKit routes such as
 * `app/[id]/page.tsx`, brace-named directories) and, with no glob support, are literal.
 */
const UNSUPPORTED_PATTERN = /[*?]|^:/;

export interface PathResolutionContext {
  /** Null for a bare repository, where restrictions are already repository-relative. */
  readonly worktreeRoot: string | null;
  readonly cwd: string;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

export function resolvePathRestrictions(
  rawPaths: readonly string[],
  ctx: PathResolutionContext,
): readonly PathRestriction[] {
  const resolved = rawPaths.map((raw) => resolveOne(raw, ctx));
  // `-- .` (or the root directory by any spelling) selects the whole repository, which is no
  // restriction at all. Passing it through produced an empty-string key that matches nothing.
  if (resolved.some((r) => r.value === '')) return [];
  return resolved;
}

function resolveOne(raw: string, ctx: PathResolutionContext): PathRestriction {
  if (raw.length === 0) {
    throw new GitWhyError('INVALID_PATH_RESTRICTION', 'A path restriction cannot be empty.');
  }
  if (UNSUPPORTED_PATTERN.test(raw)) {
    throw new GitWhyError('UNSUPPORTED_PATHSPEC', `Unsupported path pattern: "${raw}".`, {
      hint: 'Only literal file paths and directory prefixes are supported; `*` and `?` globs and pathspec magic are not.',
    });
  }

  const isDirectory = raw.endsWith('/');
  const stripped = isDirectory ? raw.slice(0, -1) : raw;

  let relative: string;
  if (ctx.worktreeRoot === null) {
    // Bare repository: the caller's string is already repository-relative.
    const normalized = toPosix(path.normalize(stripped === '' ? '.' : stripped));
    if (normalized === '..' || normalized.startsWith('../')) {
      throw new GitWhyError('INVALID_PATH_RESTRICTION', `Path escapes the repository: "${raw}".`);
    }
    relative = normalized === '.' ? '' : normalized;
  } else {
    const absolute = path.resolve(ctx.cwd, stripped === '' ? '.' : stripped);
    const rel = path.relative(ctx.worktreeRoot, absolute);
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
      throw new GitWhyError('INVALID_PATH_RESTRICTION', `Path escapes the repository: "${raw}".`);
    }
    relative = rel === '.' ? '' : toPosix(rel);
  }

  return { value: relative, kind: isDirectory ? 'directory' : 'file' };
}
