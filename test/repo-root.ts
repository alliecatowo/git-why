/**
 * Locates the repository root from a test file's own directory.
 *
 * Tests may run from `test/` directly or from the compiled mirror under
 * `.tmp/tsc-test/test/`, so a fixed number of `..` segments resolves to the
 * wrong place in one of the two schemes. Walking up to the directory that
 * actually holds `package.json` is correct under both.
 */
import fs from 'node:fs';
import path from 'node:path';

export function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'tsconfig.build.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`could not locate the repository root from ${startDir}`);
    dir = parent;
  }
}
