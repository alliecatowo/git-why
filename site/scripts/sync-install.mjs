#!/usr/bin/env node
// Copies the repo-root install.sh into site/public so it is served, byte for
// byte, at https://alliecatowo.github.io/git-why/install.sh. There is
// exactly one source of truth (../install.sh); this script keeps the two in
// sync instead of letting a copy drift.
import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const siteDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(siteDir);

const src = path.join(repoRoot, 'install.sh');
const dest = path.join(siteDir, 'public', 'install.sh');

copyFileSync(src, dest);
console.log(`site: synced install.sh -> ${path.relative(repoRoot, dest)}`);
