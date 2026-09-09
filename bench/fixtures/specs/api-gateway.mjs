// Fixture 5: an outbound API gateway with retry policy and several
// upstream provider clients.
// Covers: synonym_mismatch (x2), workaround_rationale (x2), rename (x2),
// poor_message_rich_diff (x1), distractor_intent (x3, one real reason per
// provider), no_evidence handled via corpus only.

const SUBSYS = { retry: 'retry', providers: 'providers' };

const initialFiles = [
  {
    path: 'src/retry/retry-policy.js',
    subsystem: SUBSYS.retry,
    content: `// Generic retry policy for outbound calls.
export class RetryPolicy {
  constructor(maxAttempts) {
    this.maxAttempts = maxAttempts;
  }
  async run(fn) {
    let lastErr;
    for (let i = 0; i < this.maxAttempts; i++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }
}
`,
  },
  {
    path: 'src/providers/acme-client.js',
    subsystem: SUBSYS.providers,
    content: `// Client for the Acme payments provider.
export async function callAcme(request) {
  return fetch('https://acme.example.com/api', { method: 'POST', body: request });
}
`,
  },
  {
    path: 'src/providers/globex-client.js',
    subsystem: SUBSYS.providers,
    content: `// Client for the Globex identity provider.
export const GLOBEX_TOKEN_EXPIRY_BUFFER_MS = 30_000;
export async function callGlobex(request) {
  return fetch('https://globex.example.com/api', { method: 'POST', body: request });
}
`,
  },
  {
    path: 'src/providers/initech-client.js',
    subsystem: SUBSYS.providers,
    content: `// Client for the Initech billing provider.
export async function callInitech(request) {
  return fetch('https://initech.example.com/api', { method: 'POST', body: request });
}
`,
  },
];

const beats = [
  // --- synonym_mismatch #1 (dev): "token refresh happening twice on retry" ---
  {
    id: 'retry.fix-duplicate-token-refresh',
    category: 'synonym_mismatch',
    subsystem: SUBSYS.retry,
    subject: 'Avoid refreshing the auth token on every retry attempt',
    body: `RetryPolicy.run() called the wrapped function directly, and the
wrapped function itself always fetched a fresh token before the
request. On a 3-attempt retry this meant the token endpoint got hit
3 times for what the caller experienced as a single logical call.
Cache the token for the duration of a single run() call.`,
    files: [
      {
        path: 'src/retry/retry-policy.js',
        op: 'write',
        content: `// Generic retry policy for outbound calls.
export class RetryPolicy {
  constructor(maxAttempts) {
    this.maxAttempts = maxAttempts;
  }
  async run(fn) {
    let lastErr;
    let cachedToken;
    const getToken = async (fetchToken) => (cachedToken ??= await fetchToken());
    for (let i = 0; i < this.maxAttempts; i++) {
      try {
        return await fn(getToken);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }
}
`,
      },
    ],
    note: 'Relevant fix for "token refresh happening twice on retry"; no literal overlap with the word "duplicate".',
  },
  // --- rename #1 (dev) ---
  {
    id: 'retry.rename-policy-idempotent',
    category: 'rename',
    subsystem: SUBSYS.retry,
    subject: 'Rename RetryPolicy to IdempotentRetryPolicy to be explicit about the assumption',
    body: 'Pure rename to make the idempotency assumption visible at call sites.',
    files: [
      {
        path: 'src/retry/idempotent-retry-policy.js',
        op: 'rename',
        fromPath: 'src/retry/retry-policy.js',
      },
    ],
    note: 'Single-change rename: a query about "RetryPolicy" should resolve here.',
  },
  // --- distractor_intent target: Globex ---
  {
    id: 'globex.bump-token-expiry-buffer',
    category: 'distractor_intent',
    subsystem: SUBSYS.providers,
    subject: 'Bump the Globex token expiry buffer from 30s to 90s',
    body: `Globex's own status page documents clock skew of up to 60 seconds
across their auth cluster (see their SLA doc, section 4.2). A 30s
buffer was not enough margin against that skew, causing intermittent
401s right before what our clock thought was expiry. 90s covers
their documented skew plus our own margin.`,
    files: [
      {
        path: 'src/providers/globex-client.js',
        op: 'write',
        content: `// Client for the Globex identity provider.
// Buffer widened to 90s: Globex documents up to 60s of clock skew
// across their auth cluster. See commit message.
export const GLOBEX_TOKEN_EXPIRY_BUFFER_MS = 90_000;
export async function callGlobex(request) {
  return fetch('https://globex.example.com/api', { method: 'POST', body: request });
}
`,
      },
    ],
    note: 'Real reason is Globex-specific clock skew; Acme and Initech token/response changes below are plausible-looking distractors with their own unrelated reasons.',
  },
  // --- distractor_intent target: Acme ---
  {
    id: 'acme.handle-200-with-error-body',
    category: 'distractor_intent',
    subsystem: SUBSYS.providers,
    subject: 'Treat Acme 200 responses with an error field as failures',
    body: `Acme's payment API returns HTTP 200 for rate-limited requests, with
the actual error encoded as { error: "rate_limited" } in the JSON
body instead of a 429 status (confirmed with their support ticket
#88213). Inspect the body even on a 200 so RetryPolicy actually
retries these.`,
    files: [
      {
        path: 'src/providers/acme-client.js',
        op: 'write',
        content: `// Client for the Acme payments provider.
// Acme returns 200 with { error: "rate_limited" } in the body instead
// of 429; see commit message (support ticket #88213).
export async function callAcme(request) {
  const res = await fetch('https://acme.example.com/api', { method: 'POST', body: request });
  const body = await res.json();
  if (body.error === 'rate_limited') {
    throw new Error('acme_rate_limited');
  }
  return body;
}
`,
      },
    ],
    note: 'Distractor for the Globex query and target for its own query: a different provider, different quirk, different reason.',
  },
  // --- workaround_rationale #1 (dev) ---
  {
    id: 'initech.no-retry-on-501',
    category: 'workaround_rationale',
    subsystem: SUBSYS.providers,
    subject: 'Never retry Initech 501 responses',
    body: `Initech uses HTTP 501 to mean "billing account not yet provisioned",
which resolves on their side over minutes to hours, not a transient
condition our retry policy's short backoff window would ever catch.
Retrying just adds load without ever succeeding sooner than a human
support ticket would resolve it. Confirmed with Initech's API docs,
section 9 ("Provisioning Errors").`,
    files: [
      {
        path: 'src/providers/initech-client.js',
        op: 'write',
        content: `// Client for the Initech billing provider.
// 501 from Initech means "not yet provisioned" (their docs, section
// 9), not "not implemented" -- never worth retrying. See commit msg.
export async function callInitech(request) {
  const res = await fetch('https://initech.example.com/api', { method: 'POST', body: request });
  if (res.status === 501) {
    const err = new Error('initech_not_provisioned');
    err.doNotRetry = true;
    throw err;
  }
  return res.json();
}
`,
      },
    ],
    note: 'Distractor_intent target for Initech, and also this fixture\'s first workaround_rationale case (specific documented upstream behavior).',
  },
  // --- rename #2 (test) ---
  {
    id: 'providers.rename-acme-client-file',
    category: 'rename',
    subsystem: SUBSYS.providers,
    subject: 'Rename acme-client.js to acme-payments-client.js for clarity among providers',
    body: '',
    files: [
      {
        path: 'src/providers/acme-payments-client.js',
        op: 'rename',
        fromPath: 'src/providers/acme-client.js',
      },
    ],
    note: 'Second rename case in this fixture.',
  },
  // --- synonym_mismatch #2 (test) ---
  {
    id: 'retry.fix-double-send-on-timeout',
    category: 'synonym_mismatch',
    subsystem: SUBSYS.retry,
    subject: 'Stop sending a request twice when the first attempt times out',
    body: `A timeout rejected the in-flight promise but the underlying HTTP
request could still land at the provider. On timeout, run() started
attempt 2 immediately, so a slow-but-succeeding first attempt and a
successful second attempt could both apply server-side. Track an
in-flight flag and skip starting a new attempt until the previous
one's request has actually been aborted.`,
    files: [
      {
        path: 'src/retry/idempotent-retry-policy.js',
        op: 'write',
        content: `// Generic retry policy for outbound calls. Renamed from RetryPolicy
// to make the idempotency assumption visible at call sites.
export class IdempotentRetryPolicy {
  constructor(maxAttempts) {
    this.maxAttempts = maxAttempts;
  }
  async run(fn) {
    let lastErr;
    let cachedToken;
    const getToken = async (fetchToken) => (cachedToken ??= await fetchToken());
    for (let i = 0; i < this.maxAttempts; i++) {
      const controller = new AbortController();
      try {
        return await fn(getToken, controller.signal);
      } catch (err) {
        if (err.name === 'TimeoutError') {
          controller.abort(); // wait for the abort before starting attempt i+1
          await controller.signal.aborted;
        }
        lastErr = err;
      }
    }
    throw lastErr;
  }
}
`,
      },
    ],
    note: 'Second synonym_mismatch case; phrased around "sending twice" rather than "duplicate".',
  },
  // --- poor_message_rich_diff (test) ---
  {
    id: 'providers.fix-2',
    category: 'poor_message_rich_diff',
    subsystem: SUBSYS.providers,
    subject: 'fix 2',
    body: '',
    files: [
      {
        path: 'src/providers/globex-client.js',
        op: 'write',
        content: `// Client for the Globex identity provider.
// Buffer widened to 90s: Globex documents up to 60s of clock skew
// across their auth cluster. See earlier commit message.
export const GLOBEX_TOKEN_EXPIRY_BUFFER_MS = 90_000;
export async function callGlobex(request) {
  // Globex occasionally returns a 204 with a Retry-After header
  // instead of a 429; honor it so we don't hammer them.
  const res = await fetch('https://globex.example.com/api', { method: 'POST', body: request });
  if (res.status === 204 && res.headers.get('retry-after')) {
    await new Promise((r) => setTimeout(r, Number(res.headers.get('retry-after')) * 1000));
    return callGlobex(request);
  }
  return res;
}
`,
      },
    ],
    note: 'Terse subject "fix 2"; the Retry-After handling is only visible in the diff.',
  },
  // --- workaround_rationale #2 (test) ---
  {
    id: 'acme.keep-legacy-signature-header',
    category: 'workaround_rationale',
    subsystem: SUBSYS.providers,
    subject: 'Keep sending X-Acme-Signature-V1 alongside V2',
    body: `Acme's webhook verifier on their merchant-facing dashboard (used by
roughly a dozen of our largest customers to independently audit
calls) still only checks the V1 signature header as of their last
API changelog entry. Dropping V1 would silently break that
dashboard's verification for those customers even though our own
calls only need V2. Keep sending both until Acme's dashboard is
confirmed updated.`,
    files: [
      {
        path: 'src/providers/acme-payments-client.js',
        op: 'write',
        content: `// Client for the Acme payments provider.
// Acme returns 200 with { error: "rate_limited" } in the body instead
// of 429; see earlier commit message (support ticket #88213).
export async function callAcme(request, sign) {
  const headers = {
    'X-Acme-Signature-V2': sign(request, 'v2'),
    // V1 kept for their merchant dashboard verifier; see commit
    // message. Do not remove without confirming their dashboard
    // has moved to V2-only verification.
    'X-Acme-Signature-V1': sign(request, 'v1'),
  };
  const res = await fetch('https://acme.example.com/api', { method: 'POST', body: request, headers });
  const body = await res.json();
  if (body.error === 'rate_limited') {
    throw new Error('acme_rate_limited');
  }
  return body;
}
`,
      },
    ],
    note: 'Second workaround_rationale case: a specific, cited third-party dependency on the old behavior.',
  },
];

const distractorBeats = [
  {
    id: 'distractor.initech-timeout-bump',
    category: 'distractor',
    subsystem: SUBSYS.providers,
    subject: 'Bump the Initech request timeout to 5s',
    body: 'Unrelated to the 501 no-retry rule: this only changes how long we wait before giving up, not what we do with the response.',
    files: [
      { path: 'src/providers/initech-timeout.js', op: 'write', content: 'export const INITECH_TIMEOUT_MS = 5000;\n' },
    ],
    note: 'Distractor: same provider, unrelated concern (timeout vs. retry-on-status-code).',
  },
];

export default {
  id: 'api-gateway',
  seed: 'git-why-bench::api-gateway::v1',
  theme: 'Outbound API gateway with a shared retry policy and three upstream provider clients.',
  baseEpochSeconds: 1_720_000_000,
  initialFiles,
  beats,
  fillerPlan: { count: 150, versionBumpFraction: 0.15, distractorBeats },
};
