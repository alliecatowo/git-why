#!/usr/bin/env node
/**
 * Builds the deterministic repository used by the README demo.
 *
 * The README must show real output, so this fixture is committed as a
 * generator rather than as pasted text: `mise run demo` rebuilds it and
 * re-runs the queries, and any drift shows up immediately.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SOCKET_V1 = 'export function connect(url) { return new Socket(url); }\n';
const SOCKET_V2 = `export function connect(url) {
  const s = new Socket(url);
  s.on('reconnect', () => resubscribeOnce(s));
  return s;
}
`;
const REFRESH_V1 = `export function refresh(session, refreshToken) {
  if (!refreshToken) throw new InvalidTokenError();
  return exchange(refreshToken);
}
`;
const REFRESH_V2 = `export function refresh(session, refreshToken) {
  if (!refreshToken) return session;
  return exchange(refreshToken);
}
`;

const COMMITS = [
  {
    date: '2025-10-01T10:00:00Z',
    files: { 'src/auth/refresh.ts': REFRESH_V1 },
    message: 'Add session refresh',
  },
  {
    date: '2025-10-15T10:00:00Z',
    files: { 'src/net/socket.ts': SOCKET_V1 },
    message: 'Add socket client',
  },
  {
    date: '2025-11-03T10:00:00Z',
    files: { 'src/auth/refresh.ts': REFRESH_V2 },
    message:
      'Fix infinite token-refresh loop\n\nProvider X can return an empty refresh token while the current access\ntoken remains valid. Retrying here puts clients into an infinite loop.',
  },
  {
    date: '2025-11-20T10:00:00Z',
    files: { 'src/net/socket.ts': SOCKET_V2 },
    message:
      'Stop duplicate subscriptions after reconnect\n\nReconnecting re-ran the subscribe handler without clearing the previous\nregistration, so every reconnect doubled the delivered events.',
  },
];

export function buildDemoRepo(dir = mkdtempSync(path.join(tmpdir(), 'git-why-demo-'))) {
  rmSync(path.join(dir, '.git'), { recursive: true, force: true });
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });

  git('init', '-q', '.');
  git('config', 'user.name', 'Maya Chen');
  git('config', 'user.email', 'maya@example.invalid');

  for (const commit of COMMITS) {
    for (const [rel, body] of Object.entries(commit.files)) {
      mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), body);
    }
    git('add', '-A');
    execFileSync('git', ['commit', '-q', '-m', commit.message], {
      cwd: dir,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_AUTHOR_DATE: commit.date,
        GIT_COMMITTER_DATE: commit.date,
      },
    });
  }
  return dir;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(`${buildDemoRepo()}\n`);
}
