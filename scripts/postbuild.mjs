#!/usr/bin/env node
/**
 * Post-build fixup: `tsc` preserves the `#!/usr/bin/env node` shebang line
 * verbatim (it treats a first-line `#!` specially) but does not mark the
 * emitted file executable. npm's own packing step also does not set the
 * mode. Do both explicitly and verify them, so a regression here fails
 * loudly instead of showing up later as "permission denied" after install.
 */

import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const entry = path.join(repoRoot, 'dist', 'cli', 'main.js');

if (!existsSync(entry)) {
  console.error(
    `postbuild: expected build output at ${entry}, but it does not exist. Did the build fail?`,
  );
  process.exit(1);
}

const contents = readFileSync(entry, 'utf8');
if (!contents.startsWith('#!/usr/bin/env node')) {
  console.error(`postbuild: ${entry} is missing its Node shebang as the first line.`);
  console.error(`  First line was: ${JSON.stringify(contents.split('\n')[0])}`);
  process.exit(1);
}

// rwxr-xr-x
chmodSync(entry, 0o755);

const mode = statSync(entry).mode & 0o777;
if ((mode & 0o111) === 0) {
  console.error(`postbuild: chmod did not take effect on ${entry} (mode ${mode.toString(8)}).`);
  process.exit(1);
}

console.log(
  `postbuild: ${path.relative(repoRoot, entry)} has shebang and mode ${mode.toString(8)}.`,
);
