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
export function createIsolatedProfile(profileRoot) {
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
  budgets = { wallClockMs: 8 * 60_000, toolCalls: 60, generatedTokens: 12_000 },
}) {
  const promptFilePath = buildPromptFile(promptWorkDir, { commonPreamble, taskPrompt, usageCard });

  return new Promise((resolvePromise) => {
    const startedAt = Date.now();
    const args = [
      'run',
      '--pure',
      '--agent',
      AGENT_NAME,
      '--model',
      model,
      '--format',
      'json',
      '--file',
      promptFilePath,
      '--auto', // required for non-interactive completion; applied identically to every arm
      'Complete the attached task using the permitted repository.',
    ];

    const child = spawn('opencode', args, {
      cwd,
      env: { ...process.env, ...profileEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // own process group, so a timeout kill takes descendants with it
    });

    let stdoutBuffer = '';
    let stderrBuffer = '';
    const events = [];
    const toolCalls = [];
    const parseWarnings = [];
    let sessionId = null;
    let lastStepFinish = null;
    const textChunks = [];

    let toolCallBudgetExceeded = false;
    let timedOut = false;

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
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
        });
        if (toolCalls.length > budgets.toolCalls && !toolCallBudgetExceeded) {
          toolCallBudgetExceeded = true;
          killProcessGroup(child.pid);
        }
      } else if (evt.type === 'text' && evt.part?.text) {
        textChunks.push(evt.part.text);
      } else if (evt.type === 'step_finish') {
        lastStepFinish = evt.part ?? null;
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
        usage: lastStepFinish?.tokens
          ? {
              inputTokens: lastStepFinish.tokens.input ?? null,
              outputTokens: lastStepFinish.tokens.output ?? null,
              reasoningTokens: lastStepFinish.tokens.reasoning ?? null,
              cacheReadTokens: lastStepFinish.tokens.cache?.read ?? null,
              cacheWriteTokens: lastStepFinish.tokens.cache?.write ?? null,
              totalTokens: lastStepFinish.tokens.total ?? null,
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
        actualBilledCost: lastStepFinish && 'cost' in lastStepFinish ? lastStepFinish.cost : null,
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
