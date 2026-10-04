import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probeGitCapabilitiesUncached } from '../../../src/git/exec.js';

test('capability probes ignore the caller global git config (signing, hooks)', async () => {
  const clean = await probeGitCapabilitiesUncached();

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'git-why-probe-home-'));
  // A config that would make any commit in the probe repository fail.
  fs.writeFileSync(
    path.join(home, '.gitconfig'),
    '[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /bin/false\n[core]\n\thooksPath = /nonexistent\n',
  );
  const saved = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME };
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, 'xdg');
  try {
    const hostile = await probeGitCapabilitiesUncached();
    assert.equal(hostile.attrSource, clean.attrSource);
    assert.deepEqual(hostile, clean);
  } finally {
    if (saved.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = saved.HOME;
    if (saved.XDG === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved.XDG;
  }
});
