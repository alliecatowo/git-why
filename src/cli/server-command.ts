/**
 * `git why server on|off|status|run`.
 *
 * Separate from `main.ts` because it is the one command that must work with no
 * repository, no index and no model — and because `run` never returns, which
 * is a shape the ordinary command path is not built for.
 */

import { readFileSync } from 'node:fs';
import { startDaemon } from '../daemon/server.js';
import { serverStatus, startServer, stopServer, type ServerStatus } from '../daemon/control.js';
import { ExitCode } from '../types.js';

function version(): string {
  try {
    const url = new URL('../../package.json', import.meta.url);
    return (JSON.parse(readFileSync(url, 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const USAGE = `usage: git why server <command>

  on                  Start the shared daemon if one is not already running
  off                 Stop the running daemon
  status              Report whether a daemon is running and ready
  run                 Run the daemon in the foreground (used by \`on\`)

Options:
  --json              Machine-readable output
  --check-ready       With status: exit non-zero unless a daemon is ready

The daemon holds the index, the embedding model and the lineage table open
between queries. Without it every query reopens all three, which is most of a
query's cost on a large repository.

Searches use a daemon automatically when one is running. \`--daemon=direct\`
never contacts one, \`--daemon=server\` requires one, and the default
\`--daemon=auto\` falls back to running directly whenever the daemon cannot
help — so a daemon can never be the reason a search fails.
`;

function renderStatus(status: ServerStatus): string {
  if (!status.running) return 'server: not running\n';
  const lines = [`server: ${status.ready ? 'ready' : 'running, not ready'}`];
  if (status.pid !== undefined) lines.push(`pid:    ${status.pid}`);
  if (status.url !== undefined) lines.push(`url:    ${status.url}`);
  if (status.version !== undefined) lines.push(`version:${' '}${status.version}`);
  if (status.uptimeMs !== undefined) lines.push(`uptime: ${Math.round(status.uptimeMs / 1000)}s`);
  if (status.repositories !== undefined)
    lines.push(
      `open:   ${status.repositories} repositor${status.repositories === 1 ? 'y' : 'ies'}`,
    );
  if (status.servedRequests !== undefined) lines.push(`served: ${status.servedRequests}`);
  return `${lines.join('\n')}\n`;
}

export async function runServerCommand(
  argv: readonly string[],
  io: { writeStdout: (s: string) => void; writeStderr: (s: string) => void },
): Promise<number> {
  const sub = argv[0];
  const json = argv.includes('--json');
  const checkReady = argv.includes('--check-ready');

  try {
    switch (sub) {
      case 'run': {
        // Never returns. The instance record is written once the socket is
        // listening, which is what makes `on`'s readiness poll meaningful.
        const daemon = await startDaemon({ version: version() });
        io.writeStderr(`git-why daemon listening on ${daemon.url}\n`);
        await new Promise(() => {});
        return ExitCode.OK;
      }
      case 'on': {
        const status = await startServer();
        io.writeStdout(json ? `${JSON.stringify(status, null, 2)}\n` : renderStatus(status));
        return ExitCode.OK;
      }
      case 'off': {
        const status = await stopServer();
        io.writeStdout(
          json
            ? `${JSON.stringify(status, null, 2)}\n`
            : status.running
              ? renderStatus(status)
              : 'server: stopped\n',
        );
        return status.running ? ExitCode.INDEX_FAILURE : ExitCode.OK;
      }
      case 'status': {
        const status = await serverStatus();
        io.writeStdout(json ? `${JSON.stringify(status, null, 2)}\n` : renderStatus(status));
        // `--check-ready` exists for scripts that gate on a warm daemon, and
        // "running but not answering" is a failure for that purpose.
        if (checkReady && !status.ready) return ExitCode.INDEX_FAILURE;
        return ExitCode.OK;
      }
      default:
        io.writeStderr(USAGE);
        return sub === undefined || sub === 'help' ? ExitCode.OK : ExitCode.INVALID_INVOCATION;
    }
  } catch (err) {
    io.writeStderr(`git why server: ${err instanceof Error ? err.message : String(err)}\n`);
    return ExitCode.INDEX_FAILURE;
  }
}
