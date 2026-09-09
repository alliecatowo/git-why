/**
 * Node module-resolution hook that lets `.ts` source run directly against
 * NodeNext-style relative imports (which must say `./foo.js` even though
 * only `./foo.ts` exists on disk, because that's the compiled filename
 * `tsc` will eventually produce). Verified against Node v24.21.0: native
 * type stripping executes a `.ts` file fine on its own, but does NOT fall
 * back from a `.js` specifier to a sibling `.ts` file when the `.js` file
 * doesn't exist — so `test/**\/*.test.ts` importing `../../src/foo.js`
 * fails with `ERR_MODULE_NOT_FOUND` on plain `node --test`, with no
 * package.json or tsconfig change able to fix it (this is Node's ESM
 * resolver, not TypeScript's).
 *
 * This is a workaround for that gap, not a new test framework. It adds no
 * dependency and changes no build output.
 *
 * Also verified: on this Node version, `node --test <directory>/` does NOT
 * recursively discover test files (it tries to `require()` the directory
 * itself and fails). `node --test` with no path (recursive from cwd) works,
 * and so does an explicit quoted glob such as
 * `node --test 'test/unit/**\/*.test.ts'`. That is a separate, unrelated
 * issue from the one this loader fixes — the `test:unit` / `test:integration`
 * npm scripts need one of those two forms instead of a bare directory path.
 *
 * Usage: `node --import ./scripts/ts-esm-loader.mjs --test 'test/unit/**\/*.test.ts'`
 */

import { register } from 'node:module';

export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && specifier.endsWith('.js')) {
    try {
      return await nextResolve(specifier, context);
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ERR_MODULE_NOT_FOUND') {
        return nextResolve(`${specifier.slice(0, -'.js'.length)}.ts`, context);
      }
      throw err;
    }
  }
  return nextResolve(specifier, context);
}

// This module is loaded twice: once in the main thread (via `--import`,
// where the side effect below installs the hook) and once in the
// dedicated loader thread Node spins up to run `resolve` above. Guard so
// the loader thread's own load of this file doesn't try to register again.
if (!globalThis.__gitWhyTsEsmLoaderRegistered) {
  globalThis.__gitWhyTsEsmLoaderRegistered = true;
  register(import.meta.url, import.meta.url);
}
