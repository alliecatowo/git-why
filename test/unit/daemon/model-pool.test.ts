import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ModelPool } from '../../../src/daemon/runtime.js';
import { GitWhyError } from '../../../src/types.js';

test("the daemon loads the CLIENT's requested model, not its own environment's", async () => {
  const pool = new ModelPool();
  const previous = process.env.GIT_WHY_EMBEDDING;
  process.env.GIT_WHY_EMBEDDING = 'potion-code-16M-v2'; // the daemon's own env says default
  try {
    await assert.rejects(
      () => pool.acquire({ offline: true, embedding: 'definitely-not-a-model' }),
      (err: unknown) => err instanceof GitWhyError && err.code === 'INVALID_ARGUMENTS',
    );
  } finally {
    if (previous === undefined) delete process.env.GIT_WHY_EMBEDDING;
    else process.env.GIT_WHY_EMBEDDING = previous;
    await pool.close();
  }
});

test('a client --offline stops the daemon downloading a model on its behalf', async () => {
  const pool = new ModelPool();
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'git-why-pool-'));
  const previous = process.env.GIT_WHY_MODEL_CACHE;
  process.env.GIT_WHY_MODEL_CACHE = cache; // empty cache: any load would have to download
  try {
    await assert.rejects(
      () => pool.acquire({ offline: true, embedding: '' }),
      (err: unknown) => err instanceof GitWhyError && err.code === 'OFFLINE_REQUIRED_RESOURCE',
    );
  } finally {
    if (previous === undefined) delete process.env.GIT_WHY_MODEL_CACHE;
    else process.env.GIT_WHY_MODEL_CACHE = previous;
    fs.rmSync(cache, { recursive: true, force: true });
    await pool.close();
  }
});
