// Child process for lock.test.ts: acquire shared/exclusive, hold, release.
// argv: [lockFile, kind, timeoutSeconds, holdMs]
import { acquireShared, acquireExclusive } from '../../../src/index/lock.js';

const [, , lockFile, kind, timeoutArg, holdArg] = process.argv;
const timeoutSeconds = Number(timeoutArg ?? 5);
const holdMs = Number(holdArg ?? 200);

async function main() {
  const t0 = Date.now();
  try {
    const handle =
      kind === 'shared'
        ? await acquireShared(lockFile!, timeoutSeconds)
        : await acquireExclusive(lockFile!, timeoutSeconds);
    process.stdout.write(
      JSON.stringify({ event: 'acquired', waitedMs: Date.now() - t0, pid: process.pid }) + '\n',
    );
    await new Promise((resolve) => setTimeout(resolve, holdMs));
    handle.release();
    process.stdout.write(JSON.stringify({ event: 'released', pid: process.pid }) + '\n');
  } catch (err) {
    process.stdout.write(
      JSON.stringify({
        event: 'failed',
        error: err instanceof Error ? err.message : String(err),
        code: (err as { code?: string }).code,
      }) + '\n',
    );
    process.exitCode = 1;
  }
}

void main();
