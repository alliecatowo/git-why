#!/usr/bin/env node
/**
 * Idempotently creates/verifies and pushes the authorized public GitHub
 * repository for this project.
 *
 * Safety properties this script guarantees:
 *   - Resolves the authenticated GitHub login at run time; never hardcodes
 *     an account name or assumes auth state without checking.
 *   - Never overwrites an unrelated repository and never force-pushes.
 *   - Prints the exact list of files about to be pushed and scans their
 *     content for obvious secrets before pushing anything; aborts on a hit
 *     rather than pushing past it.
 *   - Verifies real postconditions after pushing (public visibility,
 *     default branch contains the intended commit) instead of trusting a
 *     zero exit code from `gh`.
 *
 * Uses `execFileSync` with argument arrays (`shell: false`) throughout;
 * nothing here is composed as a shell string from external input.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const PRIMARY_NAME = 'git-why';
const FALLBACK_NAME = 'git-why-cli';
const DESCRIPTION = 'Semantic archaeology for Git. Find the history that explains the code.';
const PACKAGE_NAME_MARKER = '"@alliecatowo/git-why"'; // used to recognize "clearly this project"

function sh(cmd, args, opts = {}) {
  try {
    const out = execFileSync(cmd, args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    return { ok: true, stdout: out.trim() };
  } catch (err) {
    return { ok: false, stdout: '', stderr: String(err.stderr ?? err.message ?? err) };
  }
}

function die(message) {
  console.error(`repo-create: ${message}`);
  process.exit(1);
}

function resolveLogin() {
  const status = sh('gh', ['auth', 'status']);
  if (!status.ok) {
    die(
      'gh is not authenticated (gh auth status failed). Run `gh auth login` and re-run this script. ' +
        'Refusing to attempt a workaround.',
    );
  }
  const login = sh('gh', ['api', 'user', '--jq', '.login']);
  if (!login.ok || !login.stdout) {
    die(`gh api user --jq .login failed even though gh auth status succeeded: ${login.stderr}. Run \`gh auth login\`.`);
  }
  return login.stdout;
}

/** `gh repo view` as structured data, or null if the repo does not exist. */
function viewRepo(nameWithOwner) {
  const result = sh('gh', ['repo', 'view', nameWithOwner, '--json', 'name,owner,isPrivate,defaultBranchRef,url,sshUrl,description']);
  if (!result.ok) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

/** Best-effort check that an existing repo is clearly this project, not an unrelated collision. */
function looksLikeThisProject(nameWithOwner, info) {
  const branch = info?.defaultBranchRef?.name;
  if (!branch) return false; // empty repo, e.g. created by hand with no pushes yet — not clearly ours
  const contents = sh('gh', ['api', `repos/${nameWithOwner}/contents/package.json?ref=${branch}`, '--jq', '.content']);
  if (!contents.ok || !contents.stdout) return false;
  let decoded = '';
  try {
    decoded = Buffer.from(contents.stdout.replace(/\n/g, ''), 'base64').toString('utf8');
  } catch {
    return false;
  }
  return decoded.includes(PACKAGE_NAME_MARKER);
}

function chooseTargetRepo(login) {
  const primary = `${login}/${PRIMARY_NAME}`;
  const primaryInfo = viewRepo(primary);
  if (!primaryInfo) {
    return { nameWithOwner: primary, name: PRIMARY_NAME, exists: false };
  }
  if (looksLikeThisProject(primary, primaryInfo)) {
    return { nameWithOwner: primary, name: PRIMARY_NAME, exists: true, info: primaryInfo };
  }

  console.log(`repo-create: ${primary} exists and is not clearly this project; falling back to ${FALLBACK_NAME}.`);
  const fallback = `${login}/${FALLBACK_NAME}`;
  const fallbackInfo = viewRepo(fallback);
  if (!fallbackInfo) {
    return { nameWithOwner: fallback, name: FALLBACK_NAME, exists: false };
  }
  if (looksLikeThisProject(fallback, fallbackInfo)) {
    return { nameWithOwner: fallback, name: FALLBACK_NAME, exists: true, info: fallbackInfo };
  }

  die(
    `Both ${primary} and ${fallback} exist and neither is clearly this project. Refusing to overwrite an ` +
      'unrelated repository. Resolve this manually (pick a different name or delete/transfer the collision).',
  );
}

// Secret-shaped content patterns. Deliberately conservative (may over-flag);
// a false positive just requires a human to glance at the file, which is
// the point.
const SECRET_PATTERNS = [
  [/-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, 'private key block'],
  [/\bgh[oprsu]_[A-Za-z0-9]{20,}\b/, 'GitHub token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key ID'],
  [/\bxox[baprs]-[0-9A-Za-z-]{10,}\b/, 'Slack token'],
  [/\bsk-[A-Za-z0-9]{20,}\b/, 'OpenAI-style secret key'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'Google API key'],
];

const FORBIDDEN_PATH_PATTERNS = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)credentials(\.|\/|$)/i,
  /(^|\/)auth\.json$/i,
  /(^|\/)\.npmrc$/,
];

function listPushedFiles() {
  const result = sh('git', ['ls-tree', '-r', '--name-only', 'HEAD']);
  if (!result.ok) die(`could not list files at HEAD: ${result.stderr}`);
  return result.stdout.split('\n').filter(Boolean);
}

function scanForSecrets(files) {
  const findings = [];
  for (const file of files) {
    for (const pattern of FORBIDDEN_PATH_PATTERNS) {
      if (pattern.test(file)) findings.push(`${file}: forbidden path pattern (${pattern})`);
    }
    // Skip large/binary-looking files; a content scan is for text config/logs.
    if (/\.(png|jpg|jpeg|gif|ico|woff2?|ttf|zip|tgz|gz|onnx|safetensors|gguf)$/i.test(file)) continue;
    const blob = sh('git', ['show', `HEAD:${file}`]);
    if (!blob.ok) continue;
    for (const [pattern, label] of SECRET_PATTERNS) {
      if (pattern.test(blob.stdout)) findings.push(`${file}: looks like a ${label}`);
    }
  }
  return findings;
}

function ensureRemote(nameWithOwner, sshUrl) {
  const current = sh('git', ['remote', 'get-url', 'origin']);
  if (current.ok) {
    if (current.stdout !== sshUrl && !current.stdout.includes(nameWithOwner)) {
      die(
        `A remote named "origin" already points to "${current.stdout}", not "${nameWithOwner}". ` +
          'Refusing to repoint an existing remote automatically.',
      );
    }
    return;
  }
  const add = sh('git', ['remote', 'add', 'origin', sshUrl]);
  if (!add.ok) die(`git remote add origin ${sshUrl} failed: ${add.stderr}`);
}

function main() {
  const login = resolveLogin();
  console.log(`repo-create: authenticated as ${login}.`);

  const target = chooseTargetRepo(login);
  const headRev = sh('git', ['rev-parse', 'HEAD']);
  if (!headRev.ok) die(`git rev-parse HEAD failed: ${headRev.stderr}. Is this a git repository with a commit?`);

  const files = listPushedFiles();
  console.log(`\nrepo-create: ${files.length} files at HEAD (${headRev.stdout.slice(0, 12)}) will be pushed to ${target.nameWithOwner}:`);
  for (const f of files) console.log(`  ${f}`);

  const findings = scanForSecrets(files);
  if (findings.length > 0) {
    console.error('\nrepo-create: potential secrets found; aborting before any push:');
    for (const f of findings) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log('\nrepo-create: secret scan clean.');

  if (!target.exists) {
    console.log(`\nrepo-create: creating ${target.nameWithOwner} (public, no immediate push)...`);
    const create = sh('gh', ['repo', 'create', target.nameWithOwner, '--public', '--description', DESCRIPTION]);
    if (!create.ok) die(`gh repo create failed: ${create.stderr}`);
  } else {
    console.log(`\nrepo-create: reusing existing repository ${target.nameWithOwner} (recognized as this project).`);
  }

  const info = viewRepo(target.nameWithOwner);
  if (!info) die(`gh repo view ${target.nameWithOwner} failed right after creation/verification.`);
  const sshUrl = info.sshUrl ?? `git@github.com:${target.nameWithOwner}.git`;

  ensureRemote(target.nameWithOwner, sshUrl);

  const localBranch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!localBranch.ok || localBranch.stdout === 'HEAD') die('not on a named local branch; refusing to push a detached HEAD.');

  console.log(`\nrepo-create: pushing ${localBranch.stdout} -> origin/${localBranch.stdout} (no force)...`);
  const push = sh('git', ['push', '--set-upstream', 'origin', `${localBranch.stdout}:${localBranch.stdout}`]);
  if (!push.ok) {
    die(
      `git push failed: ${push.stderr}\n` +
        'This script never force-pushes. If the remote has diverged history, resolve that manually.',
    );
  }

  console.log('\nrepo-create: verifying postconditions...');
  const finalInfo = viewRepo(target.nameWithOwner);
  if (!finalInfo) die('could not re-fetch repo info to verify postconditions.');
  if (finalInfo.isPrivate) die(`${target.nameWithOwner} is private, not public. A printed gh command is not evidence.`);

  const defaultBranch = finalInfo.defaultBranchRef?.name;
  if (!defaultBranch) die(`${target.nameWithOwner} has no default branch after push.`);

  const remoteTip = sh('gh', ['api', `repos/${target.nameWithOwner}/commits/${defaultBranch}`, '--jq', '.sha']);
  if (!remoteTip.ok) die(`could not read the tip commit of ${target.nameWithOwner}@${defaultBranch}: ${remoteTip.stderr}`);
  if (remoteTip.stdout !== headRev.stdout) {
    die(
      `${target.nameWithOwner}@${defaultBranch} tip is ${remoteTip.stdout}, expected ${headRev.stdout}. ` +
        'The push did not land where expected.',
    );
  }

  console.log(`\nrepo-create: verified public, default branch "${defaultBranch}" contains ${headRev.stdout}.`);
  console.log(`repo-create: done. URL: ${finalInfo.url}`);
}

main();
