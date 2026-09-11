/**
 * Client side of the daemon, and the mode router.
 *
 * The rule that makes this safe to default on: **`auto` never fails because of
 * the daemon.** If no daemon is running, if it is unreachable, if it is a
 * different protocol version, if it declines because the index is stale — the
 * client runs the operation directly instead. A daemon is an accelerator, and
 * an accelerator that can break the tool is not worth having.
 *
 * Modelled on `zg`'s `routeByMode`, including the three modes:
 *   direct  never contact a daemon
 *   server  require one; fail loudly if it is not there
 *   auto    use one if it is usable, otherwise run directly (default)
 */

import {
  GitWhyError,
  type IndexStatus,
  type SearchRequest,
  type SearchResponse,
} from '../types.js';
import { readInstance } from './instance.js';
import {
  DAEMON_PROTOCOL_VERSION,
  type DaemonRequest,
  type DaemonResponse,
  type DaemonHealth,
} from './protocol.js';

export type DaemonMode = 'direct' | 'server' | 'auto';

export function resolveMode(explicit?: string | null): DaemonMode {
  const raw = explicit ?? process.env.GIT_WHY_MODE ?? 'auto';
  if (raw === 'direct' || raw === 'server' || raw === 'auto') return raw;
  throw new GitWhyError('INVALID_ARGUMENTS', `unknown mode "${raw}"`, {
    hint: 'use direct, server, or auto',
  });
}

/** How long a client waits before giving up on the daemon and going direct. */
const REQUEST_TIMEOUT_MS = 30_000;
const HEALTH_TIMEOUT_MS = 2_000;

async function call(
  url: string,
  token: string,
  body: DaemonRequest,
  timeoutMs: number,
): Promise<DaemonResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return (await res.json()) as DaemonResponse;
  } finally {
    clearTimeout(timer);
  }
}

export interface DaemonConnection {
  readonly url: string;
  readonly token: string;
  health(): Promise<DaemonHealth>;
  search(cwd: string, request: SearchRequest): Promise<SearchResponse>;
  status(cwd: string): Promise<IndexStatus>;
  shutdown(): Promise<void>;
}

function unwrap<T>(res: DaemonResponse, op: string, pick: (r: DaemonResponse) => T): T {
  if (!res.ok) {
    throw new GitWhyError(
      res.code as ConstructorParameters<typeof GitWhyError>[0],
      res.message,
      res.hint === undefined ? undefined : { hint: res.hint },
    );
  }
  if (res.op !== op) throw new Error(`daemon answered ${res.op} for a ${op} request`);
  return pick(res);
}

export function connect(record: { url: string; token: string }): DaemonConnection {
  const { url, token } = record;
  return {
    url,
    token,
    async health() {
      return unwrap(await call(url, token, { op: 'health' }, HEALTH_TIMEOUT_MS), 'health', (r) =>
        r.ok && r.op === 'health' ? r.health : (undefined as never),
      );
    },
    async search(cwd, request) {
      return unwrap(
        await call(url, token, { op: 'search', cwd, request }, REQUEST_TIMEOUT_MS),
        'search',
        (r) => (r.ok && r.op === 'search' ? r.response : (undefined as never)),
      );
    },
    async status(cwd) {
      return unwrap(
        await call(url, token, { op: 'status', cwd }, REQUEST_TIMEOUT_MS),
        'status',
        (r) => (r.ok && r.op === 'status' ? r.status : (undefined as never)),
      );
    },
    async shutdown() {
      await call(url, token, { op: 'shutdown', token }, HEALTH_TIMEOUT_MS);
    },
  };
}

/**
 * Returns a usable daemon, or undefined.
 *
 * "Usable" means the record exists, names a live process on this host, answers
 * a health check, and speaks this protocol version. A daemon from an older
 * install answering with a different shape is treated as absent rather than
 * negotiated with — version skew between a long-lived daemon and a freshly
 * upgraded CLI is exactly when silent misbehaviour would be hardest to spot.
 */
export async function discover(): Promise<DaemonConnection | undefined> {
  const record = readInstance();
  if (record === undefined || !record.ready) return undefined;
  const connection = connect(record);
  try {
    const health = await connection.health();
    if (health.protocolVersion !== DAEMON_PROTOCOL_VERSION) return undefined;
    return connection;
  } catch {
    return undefined;
  }
}

/**
 * Runs an operation through the daemon or directly, per mode.
 *
 * `direct` is the fallback for every recoverable daemon problem, so a caller
 * gets an answer whenever an answer is possible. The only way a daemon problem
 * reaches the user is `--mode=server`, where being explicit about wanting one
 * means being told when there isn't one.
 */
export async function route<T>(options: {
  mode: DaemonMode;
  viaDaemon: (connection: DaemonConnection) => Promise<T>;
  direct: () => Promise<T>;
  onFallback?: (reason: string) => void;
}): Promise<T> {
  if (options.mode === 'direct') return options.direct();

  const connection = await discover();
  if (connection === undefined) {
    if (options.mode === 'server') {
      throw new GitWhyError('INVALID_ARGUMENTS', 'no daemon is running', {
        hint: 'start one with `git why server on`, or drop --daemon=server',
      });
    }
    return options.direct();
  }

  try {
    return await options.viaDaemon(connection);
  } catch (err) {
    if (options.mode === 'server') throw err;
    options.onFallback?.(err instanceof Error ? err.message : String(err));
    return options.direct();
  }
}
