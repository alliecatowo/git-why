/**
 * Resolves a spawnable child helper under either test scheme.
 *
 * `npm run test:*` compiles the tree to `.tmp/tsc-test` and runs the emitted
 * JavaScript, so a sibling `.js` exists and needs no loader. Running the `.ts`
 * sources directly instead needs `scripts/ts-esm-loader.mjs` to resolve this
 * repo's NodeNext `.js` specifiers back to sibling `.ts` files. Spawning the
 * `.ts` path from the compiled tree silently produces a child that emits
 * nothing, which looks exactly like a lost race.
 */
import fs from 'node:fs';
import path from 'node:path';

export function childSpawnArgs(dir: string, repoRoot: string, baseName: string): string[] {
  const compiled = path.join(dir, `${baseName}.js`);
  if (fs.existsSync(compiled)) return [compiled];
  return [
    '--import',
    path.join(repoRoot, 'scripts', 'ts-esm-loader.mjs'),
    path.join(dir, `${baseName}.ts`),
  ];
}
