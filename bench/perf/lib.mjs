// Shared helpers for the CLI/system performance benchmark (docs/spec.md
// section 24). Everything here drives the built CLI as a subprocess; nothing
// imports src/*.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { platform, cpus, totalmem, arch } from 'node:os';
import { join, resolve } from 'node:path';

export function hardwareInfo() {
  const c = cpus();
  return {
    platform: platform(),
    arch: arch(),
    cpuModel: c[0]?.model ?? 'unknown',
    cpuCount: c.length,
    totalMemBytes: totalmem(),
  };
}

export function resolveCli(repoRoot, cliRelPath) {
  const p = resolve(repoRoot, cliRelPath);
  if (!existsSync(p)) {
    throw new Error(
      `${p} does not exist. Build the product first (npm run build / mise run build). ` +
        `bench/perf does not build src/ -- it only drives the built CLI.`,
    );
  }
  return p;
}

/** Spawn the CLI once, returning timing + parsed JSON (or raw stdout on parse failure). */
export function runOnce(cliPath, args, { cwd, env = {}, timeoutMs = 120_000 }) {
  const start = process.hrtime.bigint();
  const res = spawnSync('node', [cliPath, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  let json = null;
  let parseError = null;
  try {
    json = JSON.parse(res.stdout);
  } catch (err) {
    parseError = err.message;
  }
  return {
    elapsedMs,
    exitCode: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    json,
    parseError,
    timedOut: res.error?.code === 'ETIMEDOUT',
  };
}

/**
 * Spawn the CLI asynchronously (for concurrency scenarios), sampling the
 * aggregate RSS of the process tree (this process + any children it forks)
 * while it runs, via `ps`. macOS/BSD and Linux both support `ps -o rss=`.
 */
export function runAsyncWithMemorySampling(
  cliPath,
  args,
  { cwd, env = {}, sampleIntervalMs = 50 },
) {
  return new Promise((resolvePromise) => {
    const start = process.hrtime.bigint();
    const child = spawn('node', [cliPath, ...args], { cwd, env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    const rssSamplesKb = [];
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

    const sampler = setInterval(() => {
      const descendants = listProcessTreePids(child.pid);
      const total = sumRssKb(descendants);
      if (total !== null) rssSamplesKb.push(total);
    }, sampleIntervalMs);

    child.on('close', (code) => {
      clearInterval(sampler);
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
      let json = null;
      try {
        json = JSON.parse(stdout);
      } catch {
        /* leave json null */
      }
      resolvePromise({
        elapsedMs,
        exitCode: code,
        stdout,
        stderr,
        json,
        peakRssKb: rssSamplesKb.length ? Math.max(...rssSamplesKb) : null,
        rssSampleCount: rssSamplesKb.length,
      });
    });
  });
}

function listProcessTreePids(rootPid) {
  // Best-effort: root pid plus direct children (one level). Node CLIs here
  // are not expected to fork deep trees; documented as a known limitation
  // rather than implemented as full recursive tree walking.
  const pids = [rootPid];
  const res = spawnSync('pgrep', ['-P', String(rootPid)], { encoding: 'utf8' });
  if (res.status === 0) {
    for (const line of res.stdout.split('\n')) {
      const n = Number(line.trim());
      if (Number.isFinite(n) && n > 0) pids.push(n);
    }
  }
  return pids;
}

function sumRssKb(pids) {
  if (pids.length === 0) return null;
  const res = spawnSync('ps', ['-o', 'rss=', '-p', pids.join(',')], { encoding: 'utf8' });
  if (res.status !== 0 || !res.stdout.trim()) return null;
  const values = res.stdout
    .split('\n')
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isFinite(n));
  return values.length ? values.reduce((a, b) => a + b, 0) : null;
}

/**
 * Nearest-rank percentile: the smallest value at or above the p-th position.
 *
 * Deliberately NOT the arithmetic median for even counts — p50 here is the
 * lower-middle sample rather than the average of the two middle ones. That is
 * a standard definition and the one most latency tooling uses, and it is
 * stated because the distinction has already caused a real error elsewhere in
 * this repository: a paired-comparison median that took the UPPER-middle value
 * reported +8 tool calls where the truth was -2.5 (bench/agents/model-compare.mjs).
 *
 * It is safe here in a way it was not there. Latencies are positive and
 * unimodal, so the two definitions differ by less than one sample step — on
 * the published curl run, far less than the 291 ms between min and max. A
 * paired DELTA is signed and can be bimodal, which is what made the same
 * shortcut change a conclusion.
 */
export function percentile(sortedAscending, p) {
  if (sortedAscending.length === 0) return null;
  const idx = Math.min(
    sortedAscending.length - 1,
    Math.ceil((p / 100) * sortedAscending.length) - 1,
  );
  return sortedAscending[Math.max(0, idx)];
}

export function summarizeLatencies(samplesMs) {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    min: sorted[0] ?? null,
    max: sorted[sorted.length - 1] ?? null,
    mean: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
  };
}

/** Fresh, isolated copy of a fixture repo for a mutating perf scenario. */
export function cloneFixtureForPerf(fixtureSourceDir, perfWorkDir, scenarioId) {
  const dest = join(perfWorkDir, scenarioId);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(perfWorkDir, { recursive: true });
  cpSync(fixtureSourceDir, dest, { recursive: true });
  return dest;
}

/** An isolated HOME/XDG_CACHE_HOME so "missing model" scenarios don't touch
 * the real user's model cache. Reused across missing->cached transitions. */
export function isolatedCacheEnv(cacheHomeDir) {
  mkdirSync(cacheHomeDir, { recursive: true });
  return {
    HOME: cacheHomeDir,
    XDG_CACHE_HOME: join(cacheHomeDir, '.cache'),
  };
}

export function dirSizeBytes(dir) {
  if (!existsSync(dir)) return 0;
  const res = spawnSync('du', ['-sk', dir], { encoding: 'utf8' });
  if (res.status !== 0) return null;
  const kb = Number(res.stdout.trim().split(/\s+/)[0]);
  return Number.isFinite(kb) ? kb * 1024 : null;
}
