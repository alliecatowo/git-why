// tsc only emits JavaScript. Test fixtures (JSON, golden files) live beside the
// tests that read them by relative path, so they must be mirrored into the
// compiled tree or those reads fail with ENOENT.
import { cp, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const OUT = '.tmp/tsc-test';

for (const dir of ['test', 'src', 'schema']) {
  if (!existsSync(dir)) continue;
  await mkdir(join(OUT, dir), { recursive: true });
  await cp(dir, join(OUT, dir), {
    recursive: true,
    filter: (src) => !/\.(ts|tsx|map)$/.test(src),
  });
}
