// Fixture 1: a small realtime chat/relay service.
// Covers: synonym_mismatch (x2), deleted_implementation (x2), rename (x2),
// poor_message_rich_diff (x1), no_evidence (x2), plus churn/version filler.

const SUBSYS = { relay: 'relay', presence: 'presence', sdk: 'client-sdk' };

const initialFiles = [
  {
    path: 'src/relay/polling-dispatcher.js',
    subsystem: SUBSYS.relay,
    content: `// Legacy polling dispatcher: polls every socket pool on a 250ms
// timer and flushes any queued messages. Predates the push-based
// dispatch() below; kept only until every caller migrates off it.
export function pollAndFlush(pool, intervalMs) {
  return setInterval(() => {
    for (const [room, sockets] of pool.byRoom) {
      // ...
    }
  }, intervalMs);
}
`,
  },
  {
    path: 'src/relay/dispatch.js',
    subsystem: SUBSYS.relay,
    content: `// Fans out an incoming message to every subscriber of a room.
export function dispatch(room, message, subscribers) {
  for (const sub of subscribers.get(room) ?? []) {
    sub.send(message);
  }
}
`,
  },
  {
    path: 'src/relay/socket-pool.js',
    subsystem: SUBSYS.relay,
    content: `// Tracks live sockets per room.
export class SocketPool {
  constructor() {
    this.byRoom = new Map();
  }
  add(room, socket) {
    if (!this.byRoom.has(room)) this.byRoom.set(room, new Set());
    this.byRoom.get(room).add(socket);
  }
  remove(room, socket) {
    this.byRoom.get(room)?.delete(socket);
  }
}
`,
  },
  {
    path: 'src/presence/tracker.js',
    subsystem: SUBSYS.presence,
    content: `// Tracks which users are currently online per room.
export class PresenceTracker {
  constructor() {
    this.online = new Map();
  }
  markOnline(room, userId) {
    if (!this.online.has(room)) this.online.set(room, new Set());
    this.online.get(room).add(userId);
  }
  markOffline(room, userId) {
    this.online.get(room)?.delete(userId);
  }
}
`,
  },
  {
    path: 'src/client-sdk/socket.js',
    subsystem: SUBSYS.sdk,
    content: `// Thin wrapper around a websocket with manual reconnect.
export class ChatSocket {
  constructor(url) {
    this.url = url;
    this.ws = null;
  }
  connect() {
    this.ws = new WebSocket(this.url);
  }
}
`,
  },
  { path: 'docs/CHANGELOG.md', subsystem: 'docs', content: '# Changelog\n\n' },
  {
    path: 'src/presence/roster-view.js',
    subsystem: SUBSYS.presence,
    content: `// Renders the visible "who's online" list for a room.
export class RosterView {
  constructor() {
    this.names = [];
  }
  addUser(name) {
    this.names.push(name);
  }
  render() {
    return this.names.join(', ');
  }
}
`,
  },
];

const beats = [
  // --- deleted_implementation #1: old polling dispatcher removed ---
  {
    id: 'relay.remove-polling-dispatcher',
    category: 'deleted_implementation',
    subsystem: SUBSYS.relay,
    subject: 'Remove the legacy polling dispatcher',
    body: `The polling dispatcher polled every socket pool on a 250ms timer to
flush queued messages. It predates SocketPool's push-based dispatch()
and has been fully unused since the push path shipped. Deleting it
outright rather than deprecating, since nothing calls poll() anymore.`,
    files: [{ path: 'src/relay/polling-dispatcher.js', op: 'remove' }],
    note: 'Removed file; the deleted implementation itself, not just the removal commit, is what a "queue/dispatch before push" query should surface.',
  },
  // --- rename #1: single logical rename, old and new paths ---
  {
    id: 'relay.rename-dispatch-to-fanout',
    category: 'rename',
    subsystem: SUBSYS.relay,
    subject: 'Rename dispatch.js to fanout.js to match the "fanout" terminology used elsewhere',
    body: 'Purely a rename plus doc-comment touch-up; no behavior change.',
    files: [
      { path: 'src/relay/fanout.js', op: 'rename', fromPath: 'src/relay/dispatch.js' },
    ],
    note: 'Single-change rename: a query about the old name ("dispatch") should resolve to this commit and the current path fanout.js.',
  },
  // --- synonym_mismatch #1 (dev): "messages arriving twice after reconnect" ---
  {
    id: 'relay.fix-duplicate-dispatch-on-reconnect',
    category: 'synonym_mismatch',
    subsystem: SUBSYS.relay,
    subject: 'Fix duplicate message dispatch after reconnect',
    body: `When a client reconnects mid-session, the socket pool re-added the
socket to the room without checking it was already present, so
fanout() sent every message twice for the remainder of the session.
Guard add() with a has() check so resubscription is idempotent.`,
    files: [
      {
        path: 'src/relay/socket-pool.js',
        op: 'write',
        content: `// Tracks live sockets per room.
export class SocketPool {
  constructor() {
    this.byRoom = new Map();
  }
  add(room, socket) {
    if (!this.byRoom.has(room)) this.byRoom.set(room, new Set());
    const set = this.byRoom.get(room);
    if (set.has(socket)) return; // reconnect can re-add the same socket; stay idempotent
    set.add(socket);
  }
  remove(room, socket) {
    this.byRoom.get(room)?.delete(socket);
  }
}
`,
      },
    ],
    note: 'The relevant fix for "messages arriving twice after reconnect" -- no literal word overlap with "duplicate dispatch" beyond domain terms.',
  },
  // --- synonym_mismatch #2 (test): "a user shows up twice in the online list" ---
  {
    id: 'presence.dedupe-roster-view',
    category: 'synonym_mismatch',
    subsystem: SUBSYS.presence,
    subject: 'Deduplicate names in the roster view',
    body: `A user reconnecting from a second tab appended their name again,
so the visible online list showed the same person twice even though
PresenceTracker's internal Set was already correct. RosterView kept
its own plain array; switch it to a Set-backed dedupe.`,
    files: [
      {
        path: 'src/presence/roster-view.js',
        op: 'write',
        content: `// Renders the visible "who's online" list for a room.
export class RosterView {
  constructor() {
    this.names = new Set();
  }
  addUser(name) {
    this.names.add(name); // was Array#push, which allowed the same name twice
  }
  render() {
    return [...this.names].join(', ');
  }
}
`,
      },
    ],
    note: 'Relevant fix for "same person shows up twice in the online list"; no literal overlap with "duplicate" or "dispatch".',
  },
  // --- poor_message_rich_diff #1 (dev): terse subject, meaningful diff ---
  {
    id: 'relay.fix-issue',
    category: 'poor_message_rich_diff',
    subsystem: SUBSYS.presence,
    subject: 'fix issue',
    body: '',
    files: [
      {
        path: 'src/presence/tracker.js',
        op: 'write',
        content: `// Tracks which users are currently online per room.
export class PresenceTracker {
  constructor() {
    this.online = new Map();
    this.listenerCount = new Map();
  }
  markOnline(room, userId) {
    if (!this.online.has(room)) this.online.set(room, new Set());
    this.online.get(room).add(userId);
    // Registering a listener twice for the same room caused duplicate
    // "user joined" events; track a ref count and only attach once.
    const count = (this.listenerCount.get(room) ?? 0) + 1;
    this.listenerCount.set(room, count);
  }
  markOffline(room, userId) {
    this.online.get(room)?.delete(userId);
  }
}
`,
      },
    ],
    note: 'Subject gives no clue; the diff and its inline comment are the only evidence of "duplicated listener registration".',
  },
  // --- deleted_implementation #2 (test) ---
  {
    id: 'sdk.remove-manual-reconnect-loop',
    category: 'deleted_implementation',
    subsystem: SUBSYS.sdk,
    subject: 'Remove the hand-rolled exponential backoff loop from ChatSocket',
    body: `Replaced by the shared retry utility in a later change; deleting the
inline backoff implementation that lived directly in connect().`,
    files: [
      {
        path: 'src/client-sdk/socket.js',
        op: 'write',
        content: `// Thin wrapper around a websocket. Reconnect backoff now lives in
// the shared retry utility (see api-gateway fixture for that history).
export class ChatSocket {
  constructor(url) {
    this.url = url;
    this.ws = null;
  }
  connect() {
    this.ws = new WebSocket(this.url);
  }
}
`,
      },
    ],
    note: 'The removed inline backoff loop is the deleted implementation a "how did reconnect retry used to work" query should find.',
  },
  // --- rename #2 (test) ---
  {
    id: 'presence.rename-tracker-class',
    category: 'rename',
    subsystem: SUBSYS.presence,
    subject: 'Rename PresenceTracker to RoomPresence for consistency with RoomFanout',
    body: '',
    files: [
      {
        path: 'src/presence/room-presence.js',
        op: 'rename',
        fromPath: 'src/presence/tracker.js',
      },
    ],
    note: 'Rename case; old identifier "PresenceTracker" should resolve here.',
  },
];

const distractorBeats = [
  {
    id: 'distractor.presence-timer-jitter',
    category: 'distractor',
    subsystem: SUBSYS.presence,
    subject: 'Add jitter to the presence heartbeat timer',
    body: 'Unrelated to dispatch duplication: this only smooths heartbeat timing to avoid thundering-herd pings.',
    files: [
      {
        path: 'src/presence/heartbeat.js',
        op: 'write',
        content: `// Sends periodic presence heartbeats with random jitter to avoid
// synchronized bursts across many clients.
export function heartbeatDelay(baseMs) {
  return baseMs + Math.floor(Math.random() * 250);
}
`,
      },
    ],
    note: 'Plausible-looking but wrong distractor for the reconnect/duplicate-dispatch query: it touches timing, not delivery correctness.',
  },
  {
    id: 'distractor.sdk-double-log',
    category: 'distractor',
    subsystem: SUBSYS.sdk,
    subject: 'Avoid double-logging connection events',
    body: 'Fixes a logging duplication, not a message-delivery duplication.',
    files: [
      {
        path: 'src/client-sdk/logging.js',
        op: 'write',
        content: `// Deduplicates identical consecutive log lines from the socket client.
let lastLine = null;
export function logOnce(line) {
  if (line === lastLine) return;
  lastLine = line;
  console.log(line);
}
`,
      },
    ],
    note: 'Surface-similar ("duplicate") but about logs, not message dispatch; must not outrank the real fix.',
  },
];

export default {
  id: 'realtime-chat',
  seed: 'git-why-bench::realtime-chat::v1',
  theme: 'Realtime chat relay, presence tracking, and a client SDK.',
  baseEpochSeconds: 1_700_000_000,
  initialFiles,
  beats,
  fillerPlan: { count: 140, versionBumpFraction: 0.15, distractorBeats },
};
