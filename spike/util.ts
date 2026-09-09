// Shared helpers for the capability spike. No dependency on src/ — the spike
// is a standalone probe against the installed @zvec/zvec package and Node
// stdlib, run before any production code exists.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export interface ProbeResult {
  id: string;
  name: string;
  status: 'passed' | 'failed' | 'unsupported' | 'skipped';
  detail: string;
  evidence?: unknown;
}

export function freshTmpDir(prefix: string): string {
  const dir = path.join(os.tmpdir(), `git-why-spike-${prefix}-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function rmDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Quote a string literal for the Zvec filter grammar. Empirically (see
 * docs/decisions.md) the grammar accepts both '...' and "..." string
 * literals but proves NO working in-literal escape mechanism for the quote
 * character itself (neither doubling nor backslash-escaping parses). The
 * only verified-safe strategy is: pick whichever delimiter does not occur
 * in the value. If both quote characters occur in the value, there is no
 * proven-safe way to embed it literally — the caller must reject or strip
 * those characters before this function is called (this is why storage
 * strips quote characters from values it generates for indexed scalar
 * fields such as the normalized author search value).
 */
export function quoteFilterLiteral(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  throw new Error(
    `cannot safely quote filter literal containing both quote characters: ${JSON.stringify(value)}`,
  );
}

export function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function record(
  results: ProbeResult[],
  id: string,
  name: string,
  status: ProbeResult['status'],
  detail: string,
  evidence?: unknown,
): void {
  results.push({ id, name, status, detail, evidence });
  const tag = status === 'passed' ? 'PASS' : status === 'failed' ? 'FAIL' : status.toUpperCase();
  console.log(`[${tag}] ${id} ${name} — ${detail}`);
}

export async function runProbe(
  results: ProbeResult[],
  id: string,
  name: string,
  fn: () => Promise<{ detail: string; evidence?: unknown }> | { detail: string; evidence?: unknown },
): Promise<void> {
  try {
    const out = await fn();
    record(results, id, name, 'passed', out.detail, out.evidence);
  } catch (err) {
    const detail = err instanceof Error ? `${err.message}` : String(err);
    record(results, id, name, 'failed', detail, err instanceof Error ? { stack: err.stack } : undefined);
  }
}
