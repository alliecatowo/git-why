// Two-phase smoke checks. Preflight runs before agents; postflight consumes
// only records written by this invocation, never historical smoke output.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function run(command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 180_000 });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')}: ${result.stderr || result.stdout}`);
  return result.stdout;
}
function git(cwd, ...args) {
  return run('git', args, cwd, process.env).trim();
}

function lifecycle(toolPath) {
  const root = mkdtempSync(join(tmpdir(), 'git-why-agent-smoke-'));
  const env = { ...process.env, PATH: `${toolPath}:${process.env.PATH ?? ''}` };
  try {
    git(root, 'init');
    git(root, 'config', 'user.email', 'smoke@example.invalid');
    git(root, 'config', 'user.name', 'Smoke');
    writeFileSync(join(root, 'feature.txt'), 'needle lifecycle evidence\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'introduce needle lifecycle evidence');
    run('git-why', ['index', '--offline'], root, env);
    run('git-why', ['status', '--check-ready', '--json', '--offline'], root, env);
    const firstQuery = run(
      'git-why',
      ['needle lifecycle', '--text', '--no-refresh', '--json', '--offline'],
      root,
      env,
    );
    if (!/needle/i.test(firstQuery))
      throw new Error('initial query did not return indexed evidence');
    writeFileSync(join(root, 'feature.txt'), 'needle lifecycle evidence\nsecond-smoke-token\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'add second smoke token');
    run('git-why', ['index', '--offline'], root, env);
    const status = JSON.parse(
      run('git-why', ['status', '--check-ready', '--json', '--offline'], root, env),
    );
    const indexed =
      status.index?.indexedCommits ?? status.status?.indexedCommits ?? status.indexedCommits;
    if (indexed !== 2) throw new Error(`expected indexedCommits=2 after refresh, got ${indexed}`);
    const secondQuery = run(
      'git-why',
      ['second smoke token', '--text', '--no-refresh', '--json', '--offline'],
      root,
      env,
    );
    if (!/second-smoke-token/i.test(secondQuery))
      throw new Error('refresh query missed new commit');
    run('git-why', ['gc', '--offline'], root, env);
    const afterGc = run(
      'git-why',
      ['second smoke token', '--text', '--no-refresh', '--json', '--offline'],
      root,
      env,
    );
    if (!/second-smoke-token/i.test(afterGc)) throw new Error('query failed after gc');
    return {
      pass: true,
      detail: 'index → ready → query → commit → refresh → ready(+1) → gc → query',
    };
  } catch (error) {
    return { pass: false, detail: error.message };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function evaluatorUnreadable(sandbox) {
  if (!sandbox?.ok) return { pass: false, detail: sandbox?.reason ?? 'sandbox unavailable' };
  const probe = mkdtempSync(join(tmpdir(), 'git-why-sandbox-probe-'));
  try {
    const result = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '--read-only',
        '--tmpfs',
        '/tmp',
        '--network',
        sandbox.network ?? 'bridge',
        '--mount',
        `type=bind,src=${probe},dst=/workspace`,
        '--entrypoint',
        'sh',
        sandbox.image,
        '-lc',
        'test ! -e /evaluator && test ! -e /workspace/../evaluator',
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, ...(sandbox.dockerHost ? { DOCKER_HOST: sandbox.dockerHost } : {}) },
      },
    );
    return result.status === 0
      ? {
          pass: true,
          detail: 'fresh container has only the probe workspace mount; evaluator paths are absent',
        }
      : {
          pass: false,
          detail: result.stderr || result.stdout || 'container evaluator-read probe failed',
        };
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

export function smokePreflight({ toolPath, sandbox }) {
  return [
    { name: 'lifecycle', ...lifecycle(toolPath) },
    { name: 'isolation-mount', ...evaluatorUnreadable(sandbox) },
  ];
}

function everyArm(records, predicate) {
  return ['A', 'B', 'C', 'D'].every((arm) =>
    records.some((record) => record.arm === arm && predicate(record)),
  );
}

export function smokePostflight({ records, expectedTrials }) {
  const current = records.filter((record) => record.attempt === 1);
  const checks = [];
  checks.push({
    name: 'trial-count',
    pass: current.length === expectedTrials,
    detail: `${current.length}/${expectedTrials} first attempts recorded`,
  });
  checks.push({
    name: 'preflight',
    pass: current.every((r) => r.trajectory_audit?.valid),
    detail: 'every trial has a passing cwd/top-level/HEAD trajectory audit',
  });
  checks.push({
    name: 'treatment-ready',
    pass: everyArm(current, (r) =>
      r.arm === 'A'
        ? true
        : r.arm === 'B'
          ? Boolean(r.zg_status)
          : r.arm === 'C'
            ? Boolean(r.zg_status) && r.index_build_ms !== null
            : r.index_build_ms !== null,
    ),
    detail: 'B/C zg and C/D git-why preparations recorded',
  });
  checks.push({
    name: 'forced-use',
    pass: current.filter((r) => r.arm !== 'A').every((r) => r.forced_use_passed === true),
    detail: 'each treatment probe returned a successful non-empty result',
  });
  checks.push({
    name: 'instrumentation',
    pass: current.every(
      (r) =>
        r.events_file &&
        r.input_tokens !== null &&
        r.tool_calls !== null &&
        r.command_instrumentation,
    ),
    detail: 'events, aggregate tokens, tool counts, and command instrumentation persisted',
  });
  checks.push({
    name: 'grading',
    pass: current.every((r) => r.pass !== undefined && r.evidence_grade !== undefined),
    detail: 'each trial reached evaluator-side grading or blinded-review packet creation',
  });
  const unique = new Set(current.map((r) => r.key));
  checks.push({
    name: 'resume-key-set',
    pass: unique.size === current.length && current.every((r) => r.completed === true),
    detail:
      'bounded deterministic resume self-check: completed atomic keys are unique and therefore skipped by --resume',
  });
  return checks;
}

export function printChecklist(checks) {
  for (const check of checks)
    console.log(`[smoke] ${check.pass ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}`);
  return checks.every((check) => check.pass);
}
