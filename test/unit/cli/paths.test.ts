import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolvePathRestrictions } from '../../../src/cli/paths.js';
import { GitWhyError } from '../../../src/types.js';

const worktree = { worktreeRoot: '/repo', cwd: '/repo/src' };

test('a trailing slash makes a directory restriction', () => {
  const [r] = resolvePathRestrictions(['network/'], worktree);
  assert.deepEqual(r, { value: 'src/network', kind: 'directory' });
});

test('a bare filename makes a file restriction', () => {
  const [r] = resolvePathRestrictions(['session.ts'], worktree);
  assert.deepEqual(r, { value: 'src/session.ts', kind: 'file' });
});

test('a path already relative to the repository root resolves from cwd', () => {
  const [r] = resolvePathRestrictions(['../docs/spec.md'], worktree);
  assert.deepEqual(r, { value: 'docs/spec.md', kind: 'file' });
});

test('escaping the repository root is rejected', () => {
  assert.throws(() => resolvePathRestrictions(['../../etc/passwd'], worktree), (err: unknown) => {
    return err instanceof GitWhyError && err.code === 'INVALID_PATH_RESTRICTION';
  });
});

test('glob syntax is rejected as an unsupported pathspec', () => {
  assert.throws(() => resolvePathRestrictions(['*.ts'], worktree), (err: unknown) => {
    return err instanceof GitWhyError && err.code === 'UNSUPPORTED_PATHSPEC';
  });
});

test('pathspec magic prefix is rejected', () => {
  assert.throws(() => resolvePathRestrictions([':(icase)readme.md'], worktree), (err: unknown) => {
    return err instanceof GitWhyError && err.code === 'UNSUPPORTED_PATHSPEC';
  });
});

test('an empty restriction is rejected', () => {
  assert.throws(() => resolvePathRestrictions([''], worktree), GitWhyError);
});

test('a bare repository treats the string as already repository-relative', () => {
  const [r] = resolvePathRestrictions(['src/auth/session.ts'], { worktreeRoot: null, cwd: '/anywhere' });
  assert.deepEqual(r, { value: 'src/auth/session.ts', kind: 'file' });
});

test('a bare repository still rejects an escaping restriction', () => {
  assert.throws(() => resolvePathRestrictions(['../outside'], { worktreeRoot: null, cwd: '/anywhere' }), (err: unknown) => {
    return err instanceof GitWhyError && err.code === 'INVALID_PATH_RESTRICTION';
  });
});

test('multiple restrictions resolve independently, preserving order', () => {
  const result = resolvePathRestrictions(['a.ts', 'b/'], worktree);
  assert.deepEqual(
    result.map((r) => r.value),
    ['src/a.ts', 'src/b'],
  );
});
