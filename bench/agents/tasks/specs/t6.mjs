export default {
  id: 'T6',
  kind: 'current_code_control',
  seed: 'git-why-bench::agents::T6::v1',
  baseEpochSeconds: 1_736_000_000,
  priorHistory: [],
  baseCommit: {
    message: 'Add per-environment service URL configuration',
    files: [
      {
        path: 'src/config.cjs',
        content: `// Per-environment service endpoints. Staging must use port 8443
// (documented in ops/runbook.md, section "Staging TLS termination").
const PORTS = {
  production: 8443,
  staging: 8434, // BUG: transposed digits, should be 8443
  development: 8080,
};

function getServiceUrl(env) {
  const port = PORTS[env];
  if (port === undefined) throw new Error(\`unknown environment: \${env}\`);
  return \`https://internal.example.com:\${port}\`;
}

module.exports = { getServiceUrl, PORTS };
`,
      },
      {
        path: 'ops/runbook.md',
        content: `# Ops runbook\n\n## Staging TLS termination\n\nStaging terminates TLS on port 8443, same as production, to catch\ncertificate issues before they reach production traffic.\n`,
      },
    ],
  },
  goldFix: null,
  taskPrompt: `Something is misconfigured in src/config.cjs: staging should terminate TLS
on port 8443 (see ops/runbook.md), but a request to the staging URL is
failing to connect in practice. Find and fix the bug.`,
  hiddenTestFile: `const test = require('node:test');
const assert = require('node:assert/strict');
const { getServiceUrl } = require('../src/config.cjs');

test('staging uses port 8443 per the runbook', () => {
  assert.equal(getServiceUrl('staging'), 'https://internal.example.com:8443');
});

test('production is unaffected', () => {
  assert.equal(getServiceUrl('production'), 'https://internal.example.com:8443');
});

test('development is unaffected', () => {
  assert.equal(getServiceUrl('development'), 'https://internal.example.com:8080');
});

test('unknown environment still throws', () => {
  assert.throws(() => getServiceUrl('nope'));
});
`,
  rubric: null,
  successNote:
    'Ordinary config bug, no history needed; a control for whether history tools get used when they should not matter.',
};
