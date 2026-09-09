/**
 * Wiring seam between the CLI and the rest of the system.
 *
 * TODO(integrator): `src/git/`, `src/index/`, `src/embedding/` and
 * `src/search/` do not exist yet at the time this file was written. Once
 * they land, replace the body of `createBackend()` below with real
 * composition of those lanes into the `Backend` interface defined in
 * `./ports.ts`. Nothing else in `src/cli/` or `src/output/` should need to
 * change: they depend only on `Backend`.
 *
 * `GIT_WHY_TEST_BACKEND` is a deliberate, permanent test seam, not a
 * temporary hack: `test/integration/cli/` spawns the built
 * `dist/cli/main.js` as a real child process and points this variable at a
 * compiled fake-backend module (default export implementing `Backend`, or
 * a named `createBackend()` factory). That lets the whole CLI — argument
 * parsing, process/exit handling, human and JSON rendering — run for real
 * against a deterministic in-process fake, without a real Git repository,
 * model, or Zvec index.
 */

import type { Backend } from './ports.js';

export async function createBackend(): Promise<Backend> {
  const testBackendPath = process.env.GIT_WHY_TEST_BACKEND;
  if (testBackendPath) {
    const mod = (await import(testBackendPath)) as { default?: Backend; createBackend?: () => Backend };
    const backend = mod.default ?? mod.createBackend?.();
    if (!backend) {
      throw new Error(
        `GIT_WHY_TEST_BACKEND module at "${testBackendPath}" has no default export or createBackend() factory.`,
      );
    }
    return backend;
  }

  throw new Error(
    'Git Why is not fully wired yet: src/git, src/index, src/embedding and src/search have not been ' +
      'integrated into src/cli/wire.ts (see the TODO at the top of that file).',
  );
}
