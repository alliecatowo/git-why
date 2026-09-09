/**
 * Fake in-process backend used by test/integration/cli. Loaded at runtime
 * by the real, built `dist/cli/main.js` via the `GIT_WHY_TEST_BACKEND` seam
 * documented in `src/cli/wire.ts` — this file is plain JS, not TypeScript,
 * because it is imported directly by a child Node process with no loader
 * registered, exactly like a real deployment would import the real backend.
 *
 * Behaviour is driven entirely by the `GIT_WHY_TEST_CONFIG` environment
 * variable (a JSON-encoded object), so one fixture file can serve every
 * integration test scenario without code changes.
 *
 * `GIT_WHY_TYPES_MODULE` must point (as a file:// URL) at the built
 * `dist/types.js`, so errors thrown here are real `GitWhyError` instances
 * from the exact same module the CLI's `instanceof` checks compare against.
 */

let gitWhyErrorClassPromise;
function GitWhyErrorClass() {
  if (!gitWhyErrorClassPromise) {
    const typesUrl = process.env.GIT_WHY_TYPES_MODULE;
    if (!typesUrl) throw new Error('fake-backend: GIT_WHY_TYPES_MODULE is required');
    gitWhyErrorClassPromise = import(typesUrl).then((mod) => mod.GitWhyError);
  }
  return gitWhyErrorClassPromise;
}

function loadConfig() {
  const raw = process.env.GIT_WHY_TEST_CONFIG;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function maybeThrow(spec) {
  if (!spec) return;
  const GitWhyError = await GitWhyErrorClass();
  throw new GitWhyError(spec.code, spec.message, spec.options ?? {});
}

/** Honors AbortSignal so SIGINT tests don't have to wait out a real delay. */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    });
  });
}

function defaultIdentity(cwd) {
  return {
    commonDir: `${cwd}/.git`,
    worktreeRoot: cwd,
    isBare: false,
    isShallow: false,
    objectFormat: 'sha1',
    stateDir: `${cwd}/.git/why`,
  };
}

function defaultStatus() {
  return {
    state: 'current',
    indexPath: '/fake/index',
    generation: 'g1',
    indexedCommits: 3,
    reachableCommits: 3,
    refsChanged: false,
    recordCount: 12,
    model: { id: 'fake-model', revision: 'r1', fingerprint: 'fp1' },
    diskBytes: 4096,
    indexedAt: '2026-01-01T00:00:00Z',
    objectFormat: 'sha1',
    shallow: false,
    coverage: { excludedFiles: 0, unavailableFiles: 0, failedFiles: 0, reasons: [] },
    warnings: [],
  };
}

function defaultSearchResponse(request) {
  return {
    query: request.query,
    mode: request.mode,
    snapshot: {
      scope: 'branches-remotes-tags-worktree-heads',
      fingerprint: 'fake-fingerprint',
      indexedAt: '2026-01-01T00:00:00Z',
      freshness: 'current',
      coverage: 'complete_for_policy',
      generation: 'g1',
    },
    results: [
      {
        sha: 'a'.repeat(40),
        subject: 'Fake commit for integration testing',
        author: { name: 'Fake Author', email: 'fake@example.invalid' },
        authorTime: 1700000000,
        committerTime: 1700000000,
        parents: [],
        messageExcerpt: 'This is a fake commit used only by test/integration/cli.',
        rankScore: 0.5,
        matchedBy: request.mode === 'hybrid' ? ['text', 'semantic'] : [request.mode],
        evidence: [],
      },
    ],
    warnings: [],
    candidateLimitReached: false,
  };
}

const backend = {
  async openRepository(cwd) {
    const cfg = loadConfig();
    await maybeThrow(cfg.openRepositoryError);
    return { identity: cfg.identity ?? defaultIdentity(cwd) };
  },

  async getStatus(_repo, _options) {
    const cfg = loadConfig();
    await maybeThrow(cfg.statusError);
    return cfg.status ?? defaultStatus();
  },

  async search(_repo, request, options) {
    const cfg = loadConfig();
    if (options.onProgress) {
      options.onProgress({
        stage: 'reconcile',
        message: 'fake backend reconciling (progress on stderr)',
      });
    }
    if (cfg.searchDelayMs) await delay(cfg.searchDelayMs, options.signal);
    await maybeThrow(cfg.searchError);
    return cfg.searchResponse ?? defaultSearchResponse(request);
  },

  async index(_repo, options) {
    const cfg = loadConfig();
    if (options.onProgress) options.onProgress({ stage: 'reconcile', message: 'fake indexing' });
    await maybeThrow(cfg.indexError);
    return cfg.indexResult ?? defaultStatus();
  },

  async rebuild(_repo, options) {
    const cfg = loadConfig();
    if (options.onProgress) options.onProgress({ stage: 'reconcile', message: 'fake rebuilding' });
    await maybeThrow(cfg.rebuildError);
    return cfg.rebuildResult ?? defaultStatus();
  },

  async gc(_repo, options) {
    const cfg = loadConfig();
    if (options.onProgress) options.onProgress({ stage: 'gc', message: 'fake gc' });
    await maybeThrow(cfg.gcError);
    return cfg.gcResult ?? defaultStatus();
  },
};

export default backend;
