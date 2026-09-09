import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyPathExclusion } from '../../../src/history/exclusions.js';

test('lockfiles are excluded', () => {
  assert.equal(classifyPathExclusion('package-lock.json'), 'lockfile');
  assert.equal(classifyPathExclusion('web/yarn.lock'), 'lockfile');
  assert.equal(classifyPathExclusion('Cargo.lock'.toLowerCase()), 'lockfile');
});

test('minified artifacts are excluded', () => {
  assert.equal(classifyPathExclusion('dist-assets/app.min.js'), 'generated');
  assert.equal(classifyPathExclusion('style.min.css'), 'generated');
});

test('vendor/generated directories are excluded by whole path segment', () => {
  assert.equal(classifyPathExclusion('node_modules/left-pad/index.js'), 'generated');
  assert.equal(classifyPathExclusion('vendor/foo/bar.go'), 'generated');
  assert.equal(classifyPathExclusion('dist/bundle.js'), 'generated');
});

test('a file merely named like a generated directory is not excluded', () => {
  // "distance.ts" must not be mistaken for the "dist" directory segment.
  assert.equal(classifyPathExclusion('src/distance.ts'), null);
  assert.equal(classifyPathExclusion('src/builder.ts'), null);
});

test('binary extensions are excluded', () => {
  assert.equal(classifyPathExclusion('assets/logo.png'), 'binary');
  assert.equal(classifyPathExclusion('fonts/a.woff2'), 'binary');
});

test('configuration, dependency manifests, migrations and ordinary tests are retained', () => {
  assert.equal(classifyPathExclusion('package.json'), null);
  assert.equal(classifyPathExclusion('config/production.json'), null);
  assert.equal(classifyPathExclusion('migrations/0001_init.sql'), null);
  assert.equal(classifyPathExclusion('test/unit/history/text.test.ts'), null);
  assert.equal(classifyPathExclusion('src/__snapshots__/app.test.ts.snap'), null);
});
