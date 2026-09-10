// Post-trial trajectory audit.  This is intentionally conservative: a trial
// with an unreadable tool transcript is invalid, not "probably fine".
import { resolve, relative, isAbsolute } from 'node:path';

const EVALUATOR_MARKERS = [
  'bench/agents/tasks/hidden',
  'bench/agents/tasks/manifests',
  'bench/agents/tasks/specs',
  'bench/work/agents-tasks',
  'review-packets',
  '_index-do-not-show-reviewer',
  'transcript',
];
const NETWORK_RE =
  /\b(?:curl|wget|fetch\s+https?:|git\s+clone\s+https?:|npm\s+(?:install|view)|pip\s+install)\b/i;

function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => strings(v, out));
  return out;
}

function outsideWorkspace(candidate, workspace) {
  if (!isAbsolute(candidate)) return false;
  const rel = relative(workspace, resolve(candidate));
  return rel.startsWith('..') || isAbsolute(rel);
}

/**
 * Paths the harness itself puts inside the sandbox.
 *
 * The audit exists to catch an agent reaching outside its workspace, but the
 * runner mounts the task prompt, the agent configuration and the installed
 * `git why` tooling into the container on purpose. Reading them is the agent
 * doing exactly what it was set up to do, and flagging them invalidated
 * legitimate trials -- silently shrinking the denominator, which is worse than
 * a missed violation because it biases the result rather than merely weakening
 * it.
 *
 * This is an allowlist of the runner's own mounts, not a general escape hatch:
 * anything outside the workspace that the harness did not put there is still a
 * violation.
 */
/**
 * Filesystem roots that actually exist on the trial host or in the sandbox.
 *
 * The audit previously treated ANY slash-prefixed token as a path, so an HTTP
 * route in the agent's own code -- `/api/session`, `/webhooks/billing` -- read
 * as an escape and invalidated the trial. That is the worst kind of harness
 * bug: it removes trials from the denominator rather than adding noise, and a
 * smaller N still looks like a clean run. Nine of thirty-two trap trials were
 * lost to it before it was caught.
 *
 * A path is only a path if it begins with a real root. Anything outside the
 * workspace that does begin with one is still a violation.
 */
const FILESYSTEM_ROOTS = [
  '/Users/',
  '/home/',
  '/tmp/',
  '/var/',
  '/etc/',
  '/opt/',
  '/usr/',
  '/private/',
  '/workspace',
  '/root/',
  '/proc/',
  '/dev/',
];

function looksLikeFilesystemPath(candidate) {
  return FILESYSTEM_ROOTS.some(
    (root) => candidate === root.replace(/\/$/, '') || candidate.startsWith(root),
  );
}

const HARNESS_PATHS = [
  '/prompt/',
  '/profile-config/',
  '/data/',
  '/usr/local/share/man/',
  '/opt/git-why/',
  '/usr/local/bin/',
  '/usr/bin/',
];

function isHarnessPath(candidate) {
  const normalized = candidate.replace(/\\/g, '/');
  return HARNESS_PATHS.some(
    (prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix),
  );
}

export function auditTrajectory({
  rawEvents,
  toolCalls,
  workspaceDir,
  executionWorkspaceDir,
  baseSha,
}) {
  const violations = [];
  const workspace = resolve(executionWorkspaceDir ?? workspaceDir);
  const calls = toolCalls ?? [];
  const firstBash = calls.find((call) => call.tool === 'bash');
  const firstText = firstBash ? strings(firstBash.input).join('\n') : '';
  if (
    !/\bpwd\b/.test(firstText) ||
    !/git\s+rev-parse\s+--show-toplevel/.test(firstText) ||
    !/git\s+rev-parse\s+HEAD/.test(firstText)
  ) {
    violations.push('preflight_missing_or_not_first_bash_call');
  }
  for (const call of calls) {
    for (const text of strings(call.input)) {
      const normalized = text.replace(/\\/g, '/').toLowerCase();
      if (EVALUATOR_MARKERS.some((marker) => normalized.includes(marker)))
        violations.push('evaluator_material_reference');
      if (NETWORK_RE.test(text)) violations.push('network_fetch_attempt');
      for (const match of text.matchAll(/(?:^|\s)(\/[\w@%+.,:=~\-/]+)/g)) {
        const path = match[1];
        // `//` is commonly a search pattern or a URL delimiter, not a
        // filesystem path. It previously invalidated ordinary code searches.
        if (
          path !== '//' &&
          path !== '/tmp' &&
          !path.startsWith('/tmp/') &&
          looksLikeFilesystemPath(path) &&
          !isHarnessPath(path) &&
          outsideWorkspace(path, workspace)
        )
          violations.push(`path_outside_workspace:${path}`);
      }
    }
  }
  // The runner persists raw events so reviewers can independently inspect
  // outputs as well as inputs. A missing stream is not a valid trajectory.
  if (!Array.isArray(rawEvents) || rawEvents.length === 0) violations.push('raw_events_missing');
  return {
    valid: violations.length === 0,
    invalidation_reason: violations.length ? [...new Set(violations)].join(';') : null,
    violations: [...new Set(violations)],
    expected: { workspace, baseSha },
  };
}
