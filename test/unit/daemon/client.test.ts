import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveMode } from '../../../src/daemon/client.js';

test('auto is the default, and the env var can change it', () => {
  const previous = process.env.GIT_WHY_MODE;
  try {
    delete process.env.GIT_WHY_MODE;
    assert.equal(resolveMode(), 'auto');
    process.env.GIT_WHY_MODE = 'direct';
    assert.equal(resolveMode(), 'direct');
    // An explicit flag beats the environment, so a script can pin behaviour
    // regardless of what the shell has set.
    assert.equal(resolveMode('server'), 'server');
  } finally {
    if (previous === undefined) delete process.env.GIT_WHY_MODE;
    else process.env.GIT_WHY_MODE = previous;
  }
});

test('an unknown mode is rejected rather than silently treated as auto', () => {
  assert.throws(() => resolveMode('sever'), /unknown mode/);
});
