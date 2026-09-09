// Fixture 3: session/auth platform.
// Covers: workaround_rationale (x2), exact_identifier (x4, all about
// AuthSessionProvider), lifecycle (x3 intro+removal pairs), no_evidence
// handled via corpus only.

const SUBSYS = { session: 'session', oauth: 'oauth', compat: 'compat' };

const initialFiles = [
  {
    path: 'src/session/auth-session-provider.js',
    subsystem: SUBSYS.session,
    content: `// Central place that issues and refreshes session tokens for every
// authenticated request path in the platform.
export class AuthSessionProvider {
  constructor(store) {
    this.store = store;
  }
  async getSession(userId) {
    return this.store.get(userId);
  }
}
`,
  },
  {
    path: 'src/oauth/provider-client.js',
    subsystem: SUBSYS.oauth,
    content: `// Talks to the upstream OAuth provider's token endpoint.
export async function exchangeCode(code) {
  const res = await fetch('https://idp.example.com/token', { method: 'POST' });
  return res.json();
}
`,
  },
  {
    path: 'src/compat/legacy-mobile.js',
    subsystem: SUBSYS.compat,
    content: `// Compatibility shims for mobile app versions still in the field.
export function normalizeMobileHeaders(headers) {
  return headers;
}
`,
  },
];

const beats = [
  // --- exact_identifier #1 ---
  {
    id: 'session.add-refresh-to-provider',
    category: 'exact_identifier',
    subsystem: SUBSYS.session,
    subject: 'Add refreshSession() to AuthSessionProvider',
    body: 'Callers previously re-fetched via getSession(); refreshSession() forces a store round-trip and bumps the token version.',
    files: [
      {
        path: 'src/session/auth-session-provider.js',
        op: 'write',
        content: `// Central place that issues and refreshes session tokens for every
// authenticated request path in the platform.
export class AuthSessionProvider {
  constructor(store) {
    this.store = store;
  }
  async getSession(userId) {
    return this.store.get(userId);
  }
  async refreshSession(userId) {
    const session = await this.store.get(userId);
    session.version += 1;
    await this.store.set(userId, session);
    return session;
  }
}
`,
      },
    ],
    note: 'Exact-identifier target: literal string "AuthSessionProvider" appears in subject and diff.',
  },
  // --- workaround_rationale #1 (dev) ---
  {
    id: 'oauth.keep-empty-token-branch',
    category: 'workaround_rationale',
    subsystem: SUBSYS.oauth,
    subject: 'Keep the empty-string token branch for the legacy IdP tenant',
    body: `Our upstream OAuth provider returns access_token: "" (an empty
string, not a missing field or null) for the "legacy-tenant" client
ID when a user's consent has expired, instead of the 400 the OAuth
spec would suggest. Treat empty string as "reauth required" rather
than passing it through as a truthy value. Do not remove this branch
without confirming the legacy-tenant migration (tracked separately)
has completed -- their sandbox still exhibits this as of this commit.`,
    files: [
      {
        path: 'src/oauth/provider-client.js',
        op: 'write',
        content: `// Talks to the upstream OAuth provider's token endpoint.
export async function exchangeCode(code) {
  const res = await fetch('https://idp.example.com/token', { method: 'POST' });
  const body = await res.json();
  if (body.access_token === '') {
    // See commit message: legacy-tenant IdP quirk, not a bug here.
    return { reauthRequired: true };
  }
  return body;
}
`,
      },
    ],
    note: 'Establishes the specific upstream behavior (empty string, specific tenant) that justifies keeping the branch.',
  },
  // --- exact_identifier #2 ---
  {
    id: 'session.provider-cache-ttl',
    category: 'exact_identifier',
    subsystem: SUBSYS.session,
    subject: 'AuthSessionProvider: cache getSession() results for 30s',
    body: '',
    files: [
      {
        path: 'src/session/auth-session-provider.js',
        op: 'write',
        content: `// Central place that issues and refreshes session tokens for every
// authenticated request path in the platform.
const CACHE_TTL_MS = 30_000;
export class AuthSessionProvider {
  constructor(store) {
    this.store = store;
    this.cache = new Map();
  }
  async getSession(userId) {
    const cached = this.cache.get(userId);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
    const value = await this.store.get(userId);
    this.cache.set(userId, { value, at: Date.now() });
    return value;
  }
  async refreshSession(userId) {
    const session = await this.store.get(userId);
    session.version += 1;
    await this.store.set(userId, session);
    this.cache.delete(userId);
    return session;
  }
}
`,
      },
    ],
    note: 'Second exact-identifier commit for AuthSessionProvider.',
  },
  // --- lifecycle #1: Safari cookie workaround, introduction ---
  {
    id: 'compat.safari-cookie-workaround-intro',
    category: 'lifecycle_intro',
    subsystem: SUBSYS.compat,
    subject: 'Work around Safari dropping SameSite=None cookies without Secure',
    body: `Safari versions in the 12.0-12.1 range silently drop cookies marked
SameSite=None even when Secure is also set, due to a known Safari
bug (webkit.org/b/198181 class of issue). Detect these Safari
versions via user-agent and omit SameSite entirely for them so the
session cookie survives. Track Safari's fix rollout before removing
this branch.`,
    files: [
      {
        path: 'src/compat/legacy-mobile.js',
        op: 'write',
        content: `// Compatibility shims for mobile app versions still in the field.
export function normalizeMobileHeaders(headers) {
  return headers;
}

// Safari 12.0-12.1 workaround: see commit message. Remove once traffic
// from affected Safari versions is negligible.
export function cookieAttributesFor(userAgent) {
  if (/Safari\\/12\\.[01]/.test(userAgent)) {
    return { secure: true }; // omit SameSite
  }
  return { secure: true, sameSite: 'None' };
}
`,
      },
    ],
    note: 'Introduction half of the lifecycle case; a query about the Safari cookie workaround should surface this commit as "relevant" for the introduction.',
    lifecyclePairId: 'safari-cookie',
  },
  // --- workaround_rationale #2 (test) ---
  {
    id: 'compat.mobile-lowercase-header',
    category: 'workaround_rationale',
    subsystem: SUBSYS.compat,
    subject: 'Accept lowercase "authorization" header from app versions <= 4.2',
    body: `Mobile app releases up to and including 4.2 send the Authorization
header with an all-lowercase name on Android due to a WebView quirk
in that release's HTTP client. Newer app versions send it correctly.
Keep the case-insensitive lookup until 4.2 drops below 1% of active
sessions (tracked in the mobile team's dashboard, not in this repo).`,
    files: [
      {
        path: 'src/compat/legacy-mobile.js',
        op: 'write',
        content: `// Compatibility shims for mobile app versions still in the field.
export function normalizeMobileHeaders(headers) {
  // App versions <= 4.2 on Android send a lowercase header name.
  // See commit message for why this can't just be removed yet.
  if (headers.authorization && !headers.Authorization) {
    headers.Authorization = headers.authorization;
  }
  return headers;
}

// Safari 12.0-12.1 workaround: see commit message. Remove once traffic
// from affected Safari versions is negligible.
export function cookieAttributesFor(userAgent) {
  if (/Safari\\/12\\.[01]/.test(userAgent)) {
    return { secure: true }; // omit SameSite
  }
  return { secure: true, sameSite: 'None' };
}
`,
      },
    ],
    note: 'Second workaround_rationale case: a distinct client quirk with its own specific justification.',
  },
  // --- exact_identifier #3 ---
  {
    id: 'session.provider-metrics',
    category: 'exact_identifier',
    subsystem: SUBSYS.session,
    subject: 'Emit a metric from AuthSessionProvider on cache miss',
    body: '',
    files: [
      {
        path: 'src/session/auth-session-provider.js',
        op: 'write',
        content: `// Central place that issues and refreshes session tokens for every
// authenticated request path in the platform.
const CACHE_TTL_MS = 30_000;
export class AuthSessionProvider {
  constructor(store, metrics) {
    this.store = store;
    this.cache = new Map();
    this.metrics = metrics;
  }
  async getSession(userId) {
    const cached = this.cache.get(userId);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
    this.metrics?.increment('auth_session_provider.cache_miss');
    const value = await this.store.get(userId);
    this.cache.set(userId, { value, at: Date.now() });
    return value;
  }
  async refreshSession(userId) {
    const session = await this.store.get(userId);
    session.version += 1;
    await this.store.set(userId, session);
    this.cache.delete(userId);
    return session;
  }
}
`,
      },
    ],
    note: 'Third exact-identifier commit.',
  },
  // --- lifecycle #1: Safari cookie workaround, removal ---
  {
    id: 'compat.safari-cookie-workaround-removed',
    category: 'lifecycle_removal',
    subsystem: SUBSYS.compat,
    subject: 'Remove the Safari 12.0-12.1 SameSite cookie workaround',
    body: `Traffic from Safari 12.0-12.1 has been under 0.01% of sessions for
two full quarters and the affected versions are no longer receiving
OS updates that would let users reach us at all. Removing the
user-agent branch added earlier for this workaround.`,
    files: [
      {
        path: 'src/compat/legacy-mobile.js',
        op: 'write',
        content: `// Compatibility shims for mobile app versions still in the field.
export function normalizeMobileHeaders(headers) {
  // App versions <= 4.2 on Android send a lowercase header name.
  // See commit message for why this can't just be removed yet.
  if (headers.authorization && !headers.Authorization) {
    headers.Authorization = headers.authorization;
  }
  return headers;
}

// Safari 12.0-12.1 workaround removed: see commit message for the
// removal rationale (traffic negligible, versions unsupported).
export function cookieAttributesFor() {
  return { secure: true, sameSite: 'None' };
}
`,
      },
    ],
    note: 'Removal half of the lifecycle case; both this and the introduction commit are relevant to the same lifecycle query.',
    lifecyclePairId: 'safari-cookie',
  },
  // --- lifecycle #2: IE11 CORS preflight cache workaround, intro + removal ---
  {
    id: 'oauth.ie11-preflight-cache-intro',
    category: 'lifecycle_intro',
    subsystem: SUBSYS.oauth,
    subject: 'Cache CORS preflight responses in-memory for IE11 clients',
    body: `IE11's XDomainRequest-based fetch polyfill re-sends an OPTIONS
preflight for every single request instead of respecting
Access-Control-Max-Age, hammering the token endpoint. Cache the
preflight response client-side keyed by user-agent when IE11 is
detected. Revisit once IE11 is fully retired from the supported
browser matrix.`,
    files: [
      {
        path: 'src/oauth/ie11-preflight-cache.js',
        op: 'write',
        content: `// IE11 preflight cache: see commit message. IE11-only workaround.
const cache = new Map();
export function cachedPreflight(key, compute) {
  if (cache.has(key)) return cache.get(key);
  const value = compute();
  cache.set(key, value);
  return value;
}
`,
      },
    ],
    note: 'Introduction half of the IE11 lifecycle case.',
    lifecyclePairId: 'ie11-preflight',
  },
  // --- exact_identifier #4 ---
  {
    id: 'session.provider-dispose',
    category: 'exact_identifier',
    subsystem: SUBSYS.session,
    subject: 'Add dispose() to AuthSessionProvider to clear its cache',
    body: '',
    files: [
      {
        path: 'src/session/auth-session-provider.js',
        op: 'write',
        content: `// Central place that issues and refreshes session tokens for every
// authenticated request path in the platform.
const CACHE_TTL_MS = 30_000;
export class AuthSessionProvider {
  constructor(store, metrics) {
    this.store = store;
    this.cache = new Map();
    this.metrics = metrics;
  }
  async getSession(userId) {
    const cached = this.cache.get(userId);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
    this.metrics?.increment('auth_session_provider.cache_miss');
    const value = await this.store.get(userId);
    this.cache.set(userId, { value, at: Date.now() });
    return value;
  }
  async refreshSession(userId) {
    const session = await this.store.get(userId);
    session.version += 1;
    await this.store.set(userId, session);
    this.cache.delete(userId);
    return session;
  }
  dispose() {
    this.cache.clear();
  }
}
`,
      },
    ],
    note: 'Fourth exact-identifier commit.',
  },
  // --- lifecycle #2 removal ---
  {
    id: 'oauth.ie11-preflight-cache-removed',
    category: 'lifecycle_removal',
    subsystem: SUBSYS.oauth,
    subject: 'Delete the IE11 preflight cache now that IE11 is unsupported',
    body: `IE11 was dropped from the supported browser matrix last quarter.
Removing the preflight cache workaround added for it.`,
    files: [{ path: 'src/oauth/ie11-preflight-cache.js', op: 'remove' }],
    note: 'Removal half of the IE11 lifecycle case.',
    lifecyclePairId: 'ie11-preflight',
  },
  // --- lifecycle #3: "sucess" typo field for an old mobile client, intro + removal ---
  {
    id: 'compat.legacy-sucess-field-intro',
    category: 'lifecycle_intro',
    subsystem: SUBSYS.compat,
    subject: 'Emit both "success" and "sucess" fields for app versions <= 3.0',
    body: `App versions up to 3.0 shipped with a client-side typo and read
response.sucess (missing the c) instead of response.success. Those
clients cannot be updated (store listing pulled), so mirror the
field under both keys until version 3.0 is fully retired.`,
    files: [
      {
        path: 'src/compat/legacy-response.js',
        op: 'write',
        content: `// Mirrors "success" under the misspelled "sucess" key for app
// versions <= 3.0. See commit message.
export function withLegacySuccessField(body) {
  return { ...body, sucess: body.success };
}
`,
      },
    ],
    note: 'Introduction half of the third lifecycle case.',
    lifecyclePairId: 'legacy-sucess-field',
  },
  {
    id: 'compat.legacy-sucess-field-removed',
    category: 'lifecycle_removal',
    subsystem: SUBSYS.compat,
    subject: 'Stop emitting the "sucess" typo field',
    body: `App version 3.0 and earlier are no longer able to authenticate at
all (they use a certificate pin we rotated last month), so the
mirrored typo field is now serving zero real clients. Removing it.`,
    files: [{ path: 'src/compat/legacy-response.js', op: 'remove' }],
    note: 'Removal half of the third lifecycle case.',
    lifecyclePairId: 'legacy-sucess-field',
  },
];

const distractorBeats = [
  {
    id: 'distractor.oauth-retry-jitter',
    category: 'distractor',
    subsystem: SUBSYS.oauth,
    subject: 'Add retry with jitter to the OAuth token exchange call',
    body: 'Unrelated to the empty-token workaround: this is a transport-level retry, not a response-content branch.',
    files: [
      {
        path: 'src/oauth/retry.js',
        op: 'write',
        content: `// Retries the token exchange call with jittered backoff on network
// errors only; does not touch response body handling.
export async function withRetry(fn, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 100 * (i + 1) + Math.random() * 50));
    }
  }
}
`,
      },
    ],
    note: 'Distractor for workaround_rationale: mentions the same OAuth call but addresses network retries, not the empty-token behavior.',
  },
];

export default {
  id: 'auth-platform',
  seed: 'git-why-bench::auth-platform::v1',
  theme: 'Session/auth platform with OAuth upstream and mobile/browser compatibility shims.',
  baseEpochSeconds: 1_710_000_000,
  initialFiles,
  beats,
  fillerPlan: { count: 150, versionBumpFraction: 0.15, distractorBeats },
};
