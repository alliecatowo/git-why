import assert from 'node:assert/strict';
import test from 'node:test';
import { connect, resolveMode } from '../../../src/daemon/client.js';

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

test('--offline and the embedding choice travel in the search RPC', async () => {
  const { createServer } = await import('node:http');
  const bodies: unknown[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, op: 'search', response: { results: [] } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const connection = connect({ url: `http://127.0.0.1:${port}`, token: 't' });
    await connection.search('/repo', { query: 'q' } as never, {
      offline: true,
      embedding: 'jina-v2-small',
    });
    await connection.search('/repo', { query: 'q' } as never);
    const [withOpts, without] = bodies as Record<string, unknown>[];
    assert.equal(withOpts?.offline, true);
    assert.equal(withOpts?.embedding, 'jina-v2-small');
    assert.equal(without?.offline, undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
