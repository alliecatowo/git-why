/**
 * Default skip rules (spec section 9): binaries, common dependency
 * lockfiles, obvious minified artifacts, and confidently identified
 * generated/vendor content. Deliberately narrow -- a broad rule such as
 * "skip all JSON" or "skip all snapshots" is prohibited because it
 * discards useful history. Configuration, dependency manifests (as
 * opposed to their *lock* files), migrations and ordinary tests are
 * always retained.
 *
 * This only ever returns an `OmissionReason` used to *label* skipped
 * material; the commit summary and change metadata are always retained
 * regardless (see `src/types.ts`, `Coverage`).
 */
import type { OmissionReason } from '../types.js';

const LOCKFILE_BASENAMES: ReadonlySet<string> = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'pnpm-lock.yml',
  'composer.lock',
  'gemfile.lock',
  'cargo.lock',
  'go.sum',
  'poetry.lock',
  'pipfile.lock',
  'pdm.lock',
  'bun.lockb',
  'bun.lock',
  'mix.lock',
  'packages.lock.json',
  'flake.lock',
]);

/** Exact directory segments confidently identified as vendor/generated trees. */
const GENERATED_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  'vendor',
  'vendored',
  'third_party',
  'thirdparty',
  'node_modules',
  'generated',
  '.generated',
  'bower_components',
]);

const MINIFIED_RE = /(?:[.-]min)\.(?:js|css|mjs|cjs)$/i;

const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'ico',
  'icns',
  'pdf',
  'zip',
  'tar',
  'gz',
  'tgz',
  'bz2',
  '7z',
  'rar',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'exe',
  'dll',
  'so',
  'dylib',
  'class',
  'jar',
  'wasm',
  'mp3',
  'mp4',
  'mov',
  'avi',
  'webm',
  'psd',
  'ai',
  'sqlite',
  'sqlite3',
  'db',
  'keystore',
  'jks',
]);

function basename(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

function extension(path: string): string | null {
  const base = basename(path);
  const idx = base.lastIndexOf('.');
  return idx <= 0 ? null : base.slice(idx + 1).toLowerCase();
}

/**
 * Classify a normalised repository-relative path for exclusion purposes.
 * Returns `null` when the path should be retained (the common case).
 */
export function classifyPathExclusion(normalizedPath: string): OmissionReason | null {
  const lower = normalizedPath.toLowerCase();
  const base = basename(lower);

  if (LOCKFILE_BASENAMES.has(base)) return 'lockfile';
  if (MINIFIED_RE.test(lower)) return 'generated';

  const segments = lower.split('/').filter((s) => s.length > 0);
  // Only whole path segments count, so a file named "distance.ts" is never
  // mistaken for the "dist" generated-output directory.
  if (segments.some((s) => GENERATED_PATH_SEGMENTS.has(s))) return 'generated';
  if (segments.includes('dist') || segments.includes('build') || segments.includes('out')) {
    return 'generated';
  }

  const ext = extension(lower);
  if (ext !== null && BINARY_EXTENSIONS.has(ext)) return 'binary';

  return null;
}
