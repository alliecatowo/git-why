// Spawns OpenCode for one trial (one arm x one task x one repetition) and
// parses its --format json output, which is a newline-delimited stream of
// events (verified empirically against opencode 1.18.30: step_start,
// tool_use, text, step_finish -- NOT one final JSON object).
//
// Isolation contract (docs/spec.md section 22):
//   - A dedicated HOME/XDG-style profile per run, so ~/.config/opencode and
//     ~/.local/share/opencode never touch the real user profile. Verified
//     empirically that opencode resolves these paths from $HOME directly.
//   - Only the real auth.json is copied INTO the isolated profile (read-only
//     copy each time), so provider credentials keep working without the
//     isolated profile ever writing back to or reading anything else from
//     the real profile.
//   - `--pure` disables external plugins. The isolated profile has none
//     installed anyway (a fresh $HOME/.config/opencode has no plugin
//     node_modules), which `inspectProfile()` below confirms and records.
//   - Exactly one shared agent identity (git-why-bench) across every arm;
//     the ONLY arm-specific input is the short usage card appended to the
//     attached task prompt file, per the equal-treatment requirement.
//   - Never --continue/--fork/--session: omitting them is what makes every
//     invocation a fresh session; verified empirically (each run gets a new
//     sessionID).

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

export const AGENT_NAME = 'git-why-bench';

const COMMON_TOOLS = 'bash,read,edit,glob,grep,todowrite'; // identical across every arm

const COMMON_AGENT_MARKDOWN = `---
description: Git Why benchmark agent -- identical baseline across every arm; only the attached task prompt differs.
mode: primary
permission:
  edit: allow
  bash: allow
---

You are a careful software engineer completing one assigned task in the current repository. You have normal
shell, file read/edit, and search tools available. Source code and any permitted Git history in this repository
are available for you to consult; use your judgment about whether they are relevant to this task. Complete the
task as instructed in the attached file, then give a clear final answer summarizing what you did or found.
`;

/** Real, un-isolated opencode data dir on this machine, source of the credential copy. */
export function realAuthJsonPath() {
  return join(homedir(), '.local', 'share', 'opencode', 'auth.json');
}

/**
 * Build (or reuse) an isolated OpenCode profile directory. Idempotent:
 * safe to call once per trial or once per whole run (callers decide; a
 * fresh profile per trial is the stronger isolation guarantee and is what
 * bench/agents/run.mjs uses).
 */
export function createIsolatedProfile(profileRoot, { toolPath = null } = {}) {
  // MUST be absolute: several downstream lookups (this process's own, and
  // opencode's internal HOME-relative resolution) depend on env.HOME being
  // usable regardless of any process's current working directory. A
  // relative profileRoot silently produces a DIFFERENT resolved location
  // per-cwd and was caught during harness validation -- see bench/README.md.
  profileRoot = resolve(profileRoot);
  rmSync(profileRoot, { recursive: true, force: true });
  const configDir = join(profileRoot, '.config', 'opencode');
  const agentDir = join(configDir, 'agent');
  const dataDir = join(profileRoot, '.local', 'share', 'opencode');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  writeFileSync(join(agentDir, `${AGENT_NAME}.md`), COMMON_AGENT_MARKDOWN, 'utf8');

  const authSrc = realAuthJsonPath();
  let credentialsCopied = false;
  if (existsSync(authSrc)) {
    copyFileSync(authSrc, join(dataDir, 'auth.json'));
    credentialsCopied = true;
  }

  const env = {
    HOME: profileRoot,
    XDG_CONFIG_HOME: join(profileRoot, '.config'),
    XDG_DATA_HOME: join(profileRoot, '.local', 'share'),
    XDG_CACHE_HOME: join(profileRoot, '.cache'),
    XDG_STATE_HOME: join(profileRoot, '.local', 'state'),
  };
  // The trial only needs the packaged CLI, not this checkout's source tree.
  // Keep the product tool ahead of the ambient PATH so `git why` resolves to
  // the frozen artifact whose index the harness prepared.
  if (toolPath) env.PATH = `${toolPath}:${process.env.PATH ?? ''}`;
  return { profileRoot, env, credentialsCopied };
}

/**
 * Runs `opencode agent list` and `opencode providers list` inside the
 * isolated profile and returns their raw output, so callers can record (and
 * a human can audit) exactly what the trial's effective profile looked
 * like: which agents exist (should be opencode's built-ins plus exactly
 * git-why-bench, never a leaked custom agent from the real global config)
 * and whether the credential copy actually took (should show the same
 * provider(s) logged in as the real profile, without exposing the key
 * itself).
 */
export function inspectProfile(env) {
  const agents = spawnSync('opencode', ['agent', 'list', '--pure'], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  const providers = spawnSync('opencode', ['providers', 'list', '--pure'], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return {
    agentListExitCode: agents.status,
    agentListStdout: agents.stdout,
    providerListExitCode: providers.status,
    providerListStdout: providers.stdout,
  };
}

function buildPromptFile(promptDir, { commonPreamble, taskPrompt, usageCard }) {
  mkdirSync(promptDir, { recursive: true });
  const path = join(promptDir, 'task-prompt.md');
  const sections = [commonPreamble, taskPrompt];
  if (usageCard) sections.push('---\n\n' + usageCard);
  writeFileSync(path, sections.join('\n\n'), 'utf8');
  return path;
}

/**
 * Parses one line of `opencode run --format json` output. Returns null for
 * blank lines or lines that fail to parse (recorded by the caller as a
 * parse warning, never silently dropped from the trial record).
 */
export function parseEventLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return { type: 'unparseable', raw: trimmed };
  }
}

function killProcessGroup(pid) {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already dead */
    }
  }
}

/**
 * Run one trial. Resolves with a full trial record even on timeout/failure
 * -- it never throws for an ordinary trial failure (a provider error, a
 * budget breach, a non-zero exit); it only throws for a setup problem
 * (e.g. the opencode binary missing).
 */
export function runTrial({
  taskId,
  arm,
  repetition,
  model,
  cwd,
  profileEnv,
  commonPreamble,
  taskPrompt,
  usageCard,
  promptWorkDir,
  sandbox = null,
  budgets = { wallClockMs: 8 * 60_000, toolCalls: 60, generatedTokens: null },
}) {
  const promptFilePath = buildPromptFile(promptWorkDir, { commonPreamble, taskPrompt, usageCard });

  return new Promise((resolvePromise) => {
    const startedAt = Date.now();
    const opencodeArgs = [
      'run',
      '--pure',
      '--agent',
      AGENT_NAME,
      '--model',
      model,
      '--format',
      'json',
      // OpenCode otherwise tries to discover a project above cwd.  Trial
      // clones deliberately live outside this checkout, but make the
      // boundary explicit and auditable as well.
      '--dir',
      sandbox ? '/workspace' : cwd,
      '--file',
      sandbox ? '/prompt/task-prompt.md' : promptFilePath,
      '--auto', // required for non-interactive completion; applied identically to every arm
      'Complete the attached task using the permitted repository.',
    ];

    const containerName = sandbox ? `git-why-bench-${process.pid}-${Date.now()}` : null;
    const command = sandbox ? 'docker' : 'opencode';
    const args = sandbox
      ? [
          'run',
          '--rm',
          '--name',
          containerName,
          '--read-only',
          '--tmpfs',
          '/tmp:uid=10001,gid=10001,mode=1777',
          '--tmpfs',
          '/home/bench:uid=10001,gid=10001,mode=700',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          // The user explicitly authorized the configured DevPass credential
          // for this local smoke. It is mounted read-only in the isolated
          // profile, never copied into the image, command line, logs, or
          // result artifacts. A scoped proxy can replace bridge networking
          // later without changing the trial contract.
          '--network',
          sandbox.network ?? 'bridge',
          '--mount',
          `type=bind,src=${cwd},dst=/workspace`,
          '--mount',
          `type=bind,src=${promptWorkDir},dst=/prompt,readonly`,
          '--mount',
          `type=bind,src=${join(sandbox.profileRoot, '.config')},dst=/profile-config,readonly`,
          '--mount',
          `type=bind,src=${join(sandbox.profileRoot, '.local', 'share')},dst=/data`,
          '--env',
          'XDG_CONFIG_HOME=/profile-config',
          '--env',
          'XDG_DATA_HOME=/data',
          '--env',
          'XDG_CACHE_HOME=/tmp/cache',
          '--env',
          'XDG_STATE_HOME=/tmp/state',
          sandbox.image,
          ...opencodeArgs,
        ]
      : opencodeArgs;

    const child = spawn(command, args, {
      cwd,
      // Docker Desktop's selected context is user-scoped. Do not replace the
      // host Docker client's HOME with the trial profile; the profile is
      // mounted into the container explicitly above instead.
      env: sandbox
        ? { ...process.env, ...(sandbox.dockerHost ? { DOCKER_HOST: sandbox.dockerHost } : {}) }
        : { ...process.env, ...profileEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // own process group, so a timeout kill takes descendants with it
    });

    let stdoutBuffer = '';
    let stderrBuffer = '';
    const events = [];
    const toolCalls = [];
    const parseWarnings = [];
    let sessionId = null;
    const usageTotals = {
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      costSeen: false,
      seen: false,
    };
    const textChunks = [];

    let toolCallBudgetExceeded = false;
    let generatedTokenBudgetExceeded = false;
    let timedOut = false;

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      if (containerName) spawnSync('docker', ['kill', containerName], { stdio: 'ignore' });
      killProcessGroup(child.pid);
    }, budgets.wallClockMs);

    function handleLine(line) {
      const evt = parseEventLine(line);
      if (evt === null) return;
      if (evt.type === 'unparseable') {
        parseWarnings.push(evt.raw);
        return;
      }
      events.push(evt);
      sessionId ??= evt.sessionID ?? null;
      if (evt.type === 'tool_use' || evt.type === 'tool') {
        toolCalls.push({
          tool: evt.part?.tool ?? evt.tool ?? null,
          callID: evt.part?.callID ?? null,
          status: evt.part?.state?.status ?? null,
          input: evt.part?.state?.input ?? evt.part?.input ?? evt.input ?? null,
          output: evt.part?.state?.output ?? evt.part?.output ?? evt.output ?? null,
        });
        if (toolCalls.length > budgets.toolCalls && !toolCallBudgetExceeded) {
          toolCallBudgetExceeded = true;
          if (containerName) spawnSync('docker', ['kill', containerName], { stdio: 'ignore' });
          killProcessGroup(child.pid);
        }
      } else if (evt.type === 'text' && evt.part?.text) {
        textChunks.push(evt.part.text);
      } else if (evt.type === 'step_finish') {
        const tokens = evt.part?.tokens;
        if (tokens) {
          usageTotals.seen = true;
          usageTotals.input += Number(tokens.input ?? 0);
          usageTotals.output += Number(tokens.output ?? 0);
          usageTotals.reasoning += Number(tokens.reasoning ?? 0);
          usageTotals.cacheRead += Number(tokens.cache?.read ?? 0);
          usageTotals.cacheWrite += Number(tokens.cache?.write ?? 0);
          if (
            Number.isFinite(budgets.generatedTokens) &&
            usageTotals.output > budgets.generatedTokens &&
            !generatedTokenBudgetExceeded
          ) {
            generatedTokenBudgetExceeded = true;
            if (containerName) spawnSync('docker', ['kill', containerName], { stdio: 'ignore' });
            killProcessGroup(child.pid);
          }
        }
        // A session commonly emits several step_finish events. Cost must
        // follow the same aggregation rule as tokens; the final event alone
        // is not a session total.
        const cost = Number(evt.part?.cost);
        if (Number.isFinite(cost)) {
          usageTotals.cost += cost;
          usageTotals.costSeen = true;
        }
      }
    }

    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    });
    child.stderr.on('data', (chunk) => {
      stderrBuffer += chunk.toString('utf8');
    });

    child.on('close', (exitCode, signal) => {
      clearTimeout(timeoutTimer);
      if (stdoutBuffer.trim()) handleLine(stdoutBuffer);

      const finalPatch = spawnSync('git', ['diff', '--no-color'], { cwd, encoding: 'utf8' });
      const finalStatus = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' });

      let exitReason = 'completed';
      if (timedOut) exitReason = 'wall_clock_timeout';
      else if (toolCallBudgetExceeded) exitReason = 'tool_call_budget_exceeded';
      else if (generatedTokenBudgetExceeded) exitReason = 'generated_token_budget_exceeded';
      else if (signal) exitReason = `signal_${signal}`;
      else if (exitCode !== 0) exitReason = 'nonzero_exit';

      resolvePromise({
        taskId,
        arm,
        repetition,
        model,
        promptFilePath,
        sessionId,
        exitCode,
        signal,
        exitReason,
        wallMs: Date.now() - startedAt,
        toolCalls,
        toolCallCount: toolCalls.length,
        finalAnswer: textChunks.join(''),
        // A session can emit many step_finish events.  Reporting just the
        // last one was the source of the invalid pilot's 69k-vs-2.56M error.
        usage: usageTotals.seen
          ? {
              inputTokens: usageTotals.input,
              outputTokens: usageTotals.output,
              reasoningTokens: usageTotals.reasoning,
              cacheReadTokens: usageTotals.cacheRead,
              cacheWriteTokens: usageTotals.cacheWrite,
              totalTokens: usageTotals.input + usageTotals.output + usageTotals.reasoning,
            }
          : {
              inputTokens: null,
              outputTokens: null,
              reasoningTokens: null,
              cacheReadTokens: null,
              cacheWriteTokens: null,
              totalTokens: null,
            },
        // Never report missing cost as zero: only report it when a
        // step_finish event actually carried a cost field.
        actualBilledCost: usageTotals.costSeen ? usageTotals.cost : null,
        finalPatch: finalPatch.status === 0 ? finalPatch.stdout : null,
        workingTreeDirty: finalStatus.status === 0 ? finalStatus.stdout.trim().length > 0 : null,
        eventCount: events.length,
        parseWarnings,
        stderr: stderrBuffer,
        rawEvents: events,
      });
    });
  });
}

export { COMMON_TOOLS };
