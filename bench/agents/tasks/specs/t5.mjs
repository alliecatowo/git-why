export default {
  id: 'T5',
  kind: 'evidence_question',
  seed: 'git-why-bench::agents::T5::v1',
  baseEpochSeconds: 1_734_000_000,
  priorHistory: [
    {
      message: `Work around Safari dropping SameSite=None cookies without Secure

Safari versions in the 12.0-12.1 range silently drop cookies marked
SameSite=None even when Secure is also set, due to a known Safari
bug. Detect these Safari versions via user-agent and omit SameSite
entirely for them so the session cookie survives. Track Safari's fix
rollout before removing this branch.`,
      files: [
        {
          path: 'src/cookies.cjs',
          content: `// Compatibility shims for browser cookie quirks.
function cookieAttributesFor(userAgent) {
  if (/Safari\\/12\\.[01]/.test(userAgent)) {
    return { secure: true }; // omit SameSite
  }
  return { secure: true, sameSite: 'None' };
}
module.exports = { cookieAttributesFor };
`,
        },
      ],
    },
    {
      message: `Remove the Safari 12.0-12.1 SameSite cookie workaround

Traffic from Safari 12.0-12.1 has been under 0.01% of sessions for
two full quarters and the affected versions are no longer receiving
OS updates that would let users reach us at all. Removing the
user-agent branch added earlier for this workaround.`,
      files: [
        {
          path: 'src/cookies.cjs',
          content: `// Compatibility shims for browser cookie quirks.
// Safari 12.0-12.1 workaround removed: traffic negligible, versions
// unsupported.
function cookieAttributesFor() {
  return { secure: true, sameSite: 'None' };
}
module.exports = { cookieAttributesFor };
`,
        },
      ],
    },
  ],
  baseCommit: { message: 'Current state', files: [] },
  goldFix: null,
  taskPrompt: `We had some special-case handling for Safari and cookies at some point.
Explain, using the project's git history: why was it introduced, and when
(and why) was it removed? Cite the specific commits you're relying on. Do
not modify any code -- this is a question-answering task.`,
  hiddenTestFile: null,
  rubric: {
    mustMentionAny: ['SameSite', 'Safari 12', 'Safari 12.0', 'Safari 12.1'],
    mustMentionReasonForIntroduction:
      'Safari 12.0-12.1 silently drops SameSite=None cookies even when Secure is set',
    mustMentionReasonForRemoval:
      'traffic from those Safari versions dropped below 0.01% for two quarters and those versions are unsupported',
    mustCiteShaFromAllowedAncestry: true,
    mustNotFabricate:
      'Any additional causal claim beyond what the two commit messages state (e.g. a specific bug number, a named engineer, or a different browser) is a fabrication for grading purposes.',
    referenceAnswer:
      'Introduced because Safari 12.0-12.1 drops SameSite=None+Secure cookies (a known Safari bug); removed once Safari 12.0-12.1 traffic fell under 0.01% for two quarters and those versions no longer receive OS updates.',
  },
  successNote: 'Supported facts and valid ancestor-SHA citations; no fabricated motivation.',
};
