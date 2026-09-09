// Fixture 6: build/packaging tooling for a CLI project.
// Covers: number_version (x2), rich_message_skipped_patch (x2), no_evidence
// handled via corpus only. Mostly ordinary churn and version-number
// distractors, since this fixture doubles as the "no obvious signal"
// control for several no-evidence queries.

const SUBSYS = { build: 'build', config: 'config', release: 'release' };

const initialFiles = [
  {
    path: 'scripts/build.js',
    subsystem: SUBSYS.build,
    content: `// Compiles the CLI bundle.
export function build() {
  return { ok: true };
}
`,
  },
  {
    path: 'config/engines.json',
    subsystem: SUBSYS.config,
    content: JSON.stringify({ node: '>=16', npm: '>=7' }, null, 2) + '\n',
  },
  {
    path: 'scripts/release.js',
    subsystem: SUBSYS.release,
    content: `// Cuts a release tag and publishes the package.
export function release(version) {
  return { published: version };
}
`,
  },
  { path: 'package-lock.snapshot.txt', subsystem: 'deps', content: 'esbuild@0.19.2\n' },
];

const beats = [
  // --- number_version #1 (dev): require npm 9 ---
  {
    id: 'config.require-npm-9',
    category: 'number_version',
    subsystem: SUBSYS.config,
    subject: 'Require npm 9+ for the lockfile v3 format',
    body: `The committed lockfile moved to lockfileVersion 3 (npm's default
since npm 9) in a previous dependency update. npm 7 and 8 can read
v3 lockfiles but silently rewrite them to v2 on install, which then
diverges from CI. Requiring npm 9+ so contributors' local installs
match CI's lockfile format exactly.`,
    files: [
      {
        path: 'config/engines.json',
        op: 'write',
        content: JSON.stringify({ node: '>=16', npm: '>=9' }, null, 2) + '\n',
      },
    ],
    note: 'Real reason is the lockfile v3 format, not a generic "newer npm is better" preference.',
  },
  // --- rich_message_skipped_patch #1 (dev) ---
  {
    id: 'deps.pin-esbuild',
    category: 'rich_message_skipped_patch',
    subsystem: 'deps',
    subject: 'Pin esbuild to 0.19.2 pending a Windows path-handling fix',
    body: `esbuild 0.19.3 and 0.19.4 mis-handle backslash path separators when
resolving relative imports on Windows (upstream issue tracked in
their repo), breaking our Windows CI job. 0.19.2 is the last version
before the regression. This commit only touches the lockfile
snapshot; there is no source change.`,
    files: [
      { path: 'package-lock.snapshot.txt', op: 'write', content: 'esbuild@0.19.2\n# pinned, see commit message\n' },
    ],
    note: 'Message-only rationale surviving patch suppression; the "patch" here is an intentionally uninformative lockfile line.',
  },
  // --- number_version #2 (test): drop webpack 4 ---
  {
    id: 'build.drop-webpack-4',
    category: 'number_version',
    subsystem: SUBSYS.build,
    subject: 'Drop the webpack 4 build path; require webpack 5',
    body: `Maintaining two bundler code paths (webpack 4's stats API and
webpack 5's) doubled the surface of build.js and the webpack 4 path
had not been exercised by CI in three months since the last
project actually on webpack 4 migrated off it. Removing the
compatibility branch.`,
    files: [
      {
        path: 'scripts/build.js',
        op: 'write',
        content: `// Compiles the CLI bundle. Webpack 4 support removed: see commit
// message (unused compatibility branch, webpack 5 only going forward).
export function build() {
  return { ok: true, bundler: 'webpack5' };
}
`,
      },
    ],
    note: 'A second number/version case with its own distinct rationale, to be distinguished from the npm 9 case and from filler version bumps.',
  },
  // --- rich_message_skipped_patch #2 (test) ---
  {
    id: 'deps.bump-release-tool-major',
    category: 'rich_message_skipped_patch',
    subsystem: 'deps',
    subject: 'Bump the internal release-notes generator to its new major version',
    body: `The new major version changes its output format from a single
CHANGELOG.md rewrite to per-version files under changelog/, which
plays much better with our release script's diff-based sanity check
(it previously had to re-parse the whole file on every release).
Only the lockfile snapshot changes here; the release script itself
is updated in a follow-up commit.`,
    files: [
      { path: 'package-lock.snapshot.txt', op: 'write', content: 'esbuild@0.19.2\n# pinned, see earlier commit\nrelease-notes-gen@3.0.0\n' },
    ],
    note: 'Second rich-message/skipped-patch case: a dependency bump whose real motivation is entirely in the message.',
  },
];

const distractorBeats = [
  {
    id: 'distractor.build-cache-tweak',
    category: 'distractor',
    subsystem: SUBSYS.build,
    subject: 'Tune the build cache directory size limit',
    body: 'Unrelated performance tweak, not a version-support change.',
    files: [{ path: 'scripts/build-cache.js', op: 'write', content: 'export const CACHE_LIMIT_MB = 512;\n' }],
    note: 'Distractor: touches build tooling but is not about version support.',
  },
];

export default {
  id: 'build-tooling',
  seed: 'git-why-bench::build-tooling::v1',
  theme: 'CLI build/release tooling: engines, bundler version, pinned dev dependencies.',
  baseEpochSeconds: 1_725_000_000,
  initialFiles,
  beats,
  fillerPlan: { count: 160, versionBumpFraction: 0.25, distractorBeats },
};
