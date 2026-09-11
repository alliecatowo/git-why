/**
 * The daemon itself: a loopback HTTP server that answers searches from warm
 * handles.
 *
 * Security posture, matching `zg`: loopback only, never a routable interface.
 * Every request must carry the bearer token from the instance record, which is
 * written mode 0600 — so "can you read the token file" is the authorisation
 * check, and it is the same question as "can you read the index", which any
 * local process with filesystem access could already do. The daemon therefore
 * grants nothing that was not already available; it only makes it faster.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { hostname } from 'node:os';
import { captureSnapshot } from '../git/snapshot.js';
import { search as runSearch } from '../search/search.js';
import { GitWhyError } from '../types.js';
import { coverageSummaryOf, createBackend, toSnapshotSummary } from '../cli/wire.js';
import { RuntimeManager } from './runtime.js';
import { clearInstance, newToken, writeInstance, type InstanceRecord } from './instance.js';
import { DAEMON_PROTOCOL_VERSION, type DaemonRequest, type DaemonResponse } from './protocol.js';

const MAX_BODY_BYTES = 1 << 20;

export interface DaemonOptions {
  readonly host?: string;
  readonly port?: number;
  readonly idleTtlMs?: number;
  readonly version: string;
}

export interface RunningDaemon {
  readonly url: string;
  readonly token: string;
  readonly server: Server;
  close(): Promise<void>;
}

export async function startDaemon(options: DaemonOptions): Promise<RunningDaemon> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  const runtimes = new RuntimeManager({ idleTtlMs: options.idleTtlMs });
  const token = newToken();
  const startedAt = Date.now();
  let servedRequests = 0;

  const handle = async (body: DaemonRequest): Promise<DaemonResponse> => {
    switch (body.op) {
      case 'health': {
        const snap = runtimes.snapshot();
        return {
          ok: true,
          op: 'health',
          health: {
            protocolVersion: DAEMON_PROTOCOL_VERSION,
            version: options.version,
            pid: process.pid,
            uptimeMs: Date.now() - startedAt,
            repositories: snap.repositories,
            openReaders: snap.openReaders,
            servedRequests,
          },
        };
      }
      case 'status': {
        // Status deliberately does NOT use warm handles. It reports disk usage
        // and coverage counts that are properties of the filesystem right now,
        // and a cached answer to "is my index current" is the one answer
        // nobody wants. It runs through the ordinary backend, so there is one
        // implementation of what status means.
        const backend = await createBackend();
        const repo = await backend.openRepository(body.cwd);
        return {
          ok: true,
          op: 'status',
          status: await backend.getStatus(repo, {
            lockTimeoutMs: 30_000,
            signal: new AbortController().signal,
          }),
        };
      }
      case 'search': {
        const needsEmbedder = body.request.mode !== 'text';
        const lease = await runtimes.acquire(body.cwd, { needsEmbedder });
        try {
          // A stale index must not be served silently as though it were
          // current. The daemon has no mandate to refresh — refreshing takes
          // an exclusive lock and can take minutes — so it declines and the
          // client falls back to running directly, which can.
          if (lease.stale) {
            throw new GitWhyError('INDEX_STALE', 'the index is not current for this repository', {
              hint: 'run `git why index --if-needed`, or query without the daemon',
            });
          }
          const snapshot = await captureSnapshot(lease.identity);
          const summary = toSnapshotSummary(
            snapshot,
            lease.generationId,
            lease.manifest.updatedAt,
            'current',
            coverageSummaryOf(lease.manifest.omissions),
          );
          const response = await runSearch(
            body.request,
            lease.store,
            needsEmbedder ? lease.embedder : null,
            summary,
            lease.lineage,
          );
          servedRequests += 1;
          return { ok: true, op: 'search', response };
        } finally {
          lease.release();
        }
      }
      case 'shutdown': {
        if (body.token !== token) {
          return { ok: false, code: 'FORBIDDEN', message: 'bad control token' };
        }
        setTimeout(() => void close(), 10).unref?.();
        return { ok: true, op: 'shutdown' };
      }
      default:
        return { ok: false, code: 'INVALID_ARGUMENTS', message: 'unknown operation' };
    }
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const send = (status: number, payload: DaemonResponse) => {
        const text = JSON.stringify(payload);
        res.writeHead(status, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(text),
        });
        res.end(text);
      };
      if (req.method !== 'POST') {
        send(405, { ok: false, code: 'INVALID_ARGUMENTS', message: 'POST only' });
        return;
      }
      if (req.headers.authorization !== `Bearer ${token}`) {
        send(401, { ok: false, code: 'FORBIDDEN', message: 'missing or bad bearer token' });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY_BYTES) {
          send(413, { ok: false, code: 'INVALID_ARGUMENTS', message: 'request too large' });
          req.destroy();
          return;
        }
        chunks.push(chunk as Buffer);
      }
      let body: DaemonRequest;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as DaemonRequest;
      } catch {
        send(400, { ok: false, code: 'INVALID_ARGUMENTS', message: 'malformed JSON' });
        return;
      }
      try {
        send(200, await handle(body));
      } catch (err) {
        // A product error is a normal outcome the client will re-raise with
        // the right exit code, so it is reported as data rather than a 500.
        if (err instanceof GitWhyError) {
          send(200, {
            ok: false,
            code: err.code,
            message: err.message,
            ...(err.hint === undefined ? {} : { hint: err.hint }),
          });
          return;
        }
        send(200, {
          ok: false,
          code: 'INTERNAL',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;
  const url = `http://${host}:${boundPort}`;

  const record: InstanceRecord = {
    pid: process.pid,
    hostname: hostname(),
    token,
    url,
    startedAt: new Date(startedAt).toISOString(),
    ready: true,
    version: options.version,
  };
  writeInstance(record);

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearInstance();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtimes.close();
  };

  // A daemon serves many repositories. A fault caused by one request must
  // never end service for all of them, so the last-resort handlers log and
  // keep running rather than letting the default behaviour exit the process.
  // This is a backstop, not a substitute for handling errors where they occur:
  // anything reaching here is a bug worth the log line it produces.
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(
      `git-why daemon: unhandled rejection (continuing): ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}\n`,
    );
  });
  process.on('uncaughtException', (err) => {
    process.stderr.write(
      `git-why daemon: uncaught exception (continuing): ${err.stack ?? err.message}\n`,
    );
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void close().then(() => process.exit(0));
    });
  }

  return { url, token, server, close };
}
