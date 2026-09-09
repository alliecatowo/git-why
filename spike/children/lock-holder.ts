// Child process: acquire a shared or exclusive lock via lock-proto.ts, hold
// it, and report progress on stdout as newline-delimited JSON so the parent
// can observe acquisition timing and (for SIGKILL tests) release-by-death.
// argv: [lockDir, kind, timeoutMs, holdMs]
import { acquireShared, acquireExclusive } from '../lock-proto.ts';

const [, , lockDir, kind, timeoutArg, holdArg] = process.argv;
const timeoutMs = Number(timeoutArg ?? 5000);
const holdMs = Number(holdArg ?? 500);

async function main() {
  const t0 = Date.now();
  try {
    const handle = kind === 'shared' ? await acquireShared(lockDir!, timeoutMs) : await acquireExclusive(lockDir!, timeoutMs);
    process.stdout.write(JSON.stringify({ event: 'acquired', kind, waitedMs: Date.now() - t0, pid: process.pid }) + '\n');
    await new Promise((resolve) => setTimeout(resolve, holdMs));
    handle.release();
    process.stdout.write(JSON.stringify({ event: 'released', kind, pid: process.pid }) + '\n');
  } catch (err) {
    process.stdout.write(JSON.stringify({ event: 'failed', kind, error: err instanceof Error ? err.message : String(err) }) + '\n');
    process.exitCode = 1;
  }
}

void main();
