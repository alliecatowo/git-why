// Shared vocabulary for procedurally generated filler/distractor commits.
// Authored "story beat" commits (the ones dataset queries target) are
// hand-written per fixture spec, not drawn from here.

export const CHURN_SUBJECTS = [
  'Tidy up imports in {file}',
  'Update comment in {file}',
  'Reformat {file}',
  'Adjust logging verbosity in {file}',
  'Minor cleanup in {file}',
  'Remove unused variable in {file}',
  'Simplify conditional in {file}',
  'Extract helper in {file}',
  'Add missing semicolon in {file}',
  'Rename local variable in {file}',
  'Improve readability of {file}',
  'Fix typo in {file} comment',
  'Reorder function arguments in {file}',
  'Consolidate constants in {file}',
  'Drop dead code path in {file}',
  'Normalize whitespace in {file}',
  'Align {file} with lint rules',
  'Small refactor of {file}',
  'Update inline docs for {file}',
  'Trim trailing whitespace in {file}',
];

export const VERSION_BUMP_SUBJECTS = [
  'Bump {dep} to {version}',
  'Update {dep} dependency to {version}',
  'Upgrade {dep} to v{version}',
  'chore: bump {dep} {version}',
  'Pin {dep} at {version}',
];

export const DEPENDENCIES = [
  'lodash', 'axios', 'chalk', 'commander', 'dotenv', 'express',
  'jest', 'eslint', 'prettier', 'webpack', 'babel-core', 'moment',
  'uuid', 'ws', 'pg', 'ioredis', 'node-fetch', 'yargs',
];

export function semverLike(rng, randInt) {
  return `${randInt(rng, 1, 9)}.${randInt(rng, 0, 20)}.${randInt(rng, 0, 30)}`;
}

export const CHURN_COMMENT_LINES = [
  '// NOTE: revisit this after the Q3 cleanup',
  '// TODO: consider caching this lookup',
  '// keep in sync with the schema doc',
  '// this is intentionally verbose for now',
  '// see internal wiki for background',
  '// no functional change',
  '// tightened types slightly',
  '// matches the style used elsewhere in this module',
];
