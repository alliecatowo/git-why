import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildCommitText,
  buildHunkText,
  clipToBytes,
  tokenizeForLexical,
} from '../../../src/history/text.js';
import { makeFakeEmbedder } from './fakes.js';

test('tokenizeForLexical retains 13 and 18 as distinct tokens', () => {
  const a = tokenizeForLexical('retry after 13 attempts');
  const b = tokenizeForLexical('retry after 18 attempts');
  assert.ok(a.includes('13'));
  assert.ok(!a.includes('18'));
  assert.ok(b.includes('18'));
  assert.ok(!b.includes('13'));
});

test('tokenizeForLexical keeps AuthSessionProvider matchable as itself and by components', () => {
  const tokens = tokenizeForLexical('class AuthSessionProvider implements Provider {}');
  assert.ok(tokens.includes('AuthSessionProvider'), 'whole identifier retained');
  assert.ok(
    tokens.some((t) => t.toLowerCase() === 'auth'),
    'Auth component present',
  );
  assert.ok(
    tokens.some((t) => t.toLowerCase() === 'session'),
    'Session component present',
  );
  assert.ok(
    tokens.some((t) => t.toLowerCase() === 'provider'),
    'Provider component present',
  );
});

test('tokenizeForLexical decomposes snake_case while retaining the original', () => {
  const tokens = tokenizeForLexical('max_retry_count = 5');
  assert.ok(tokens.includes('max_retry_count'));
  assert.ok(tokens.includes('max'));
  assert.ok(tokens.includes('retry'));
  assert.ok(tokens.includes('count'));
});

test('tokenizeForLexical decomposes path and version components', () => {
  const tokens = tokenizeForLexical('bump src/auth/session.ts to v1.2.3');
  assert.ok(tokens.includes('src/auth/session.ts'));
  assert.ok(tokens.includes('src'));
  assert.ok(tokens.includes('auth'));
  assert.ok(tokens.includes('session'));
  assert.ok(tokens.includes('ts'));
  assert.ok(tokens.includes('v1.2.3'));
  assert.ok(tokens.includes('v1'));
  assert.ok(tokens.includes('2'));
  assert.ok(tokens.includes('3'));
});

test('tokenizeForLexical ignores natural-language punctuation as separators only', () => {
  const tokens = tokenizeForLexical('Why did this loop (again)? "auth-session" failed.');
  assert.ok(tokens.includes('auth-session'));
  assert.ok(tokens.some((t) => t.toLowerCase() === 'auth'));
  assert.ok(tokens.some((t) => t.toLowerCase() === 'session'));
});

test('clipToBytes never splits a multi-byte UTF-8 character', () => {
  const text = 'a'.repeat(9) + '€'; // '€' is 3 bytes in UTF-8
  const result = clipToBytes(text, 10);
  assert.ok(result.clipped);
  assert.equal(Buffer.byteLength(result.text, 'utf8') <= 10, true);
  // must not contain a partial multi-byte sequence
  assert.equal(Buffer.from(result.text, 'utf8').toString('utf8'), result.text);
});

test('clipToBytes reports unclipped when text already fits', () => {
  const result = clipToBytes('short', 100);
  assert.equal(result.clipped, false);
  assert.equal(result.text, 'short');
});

test('buildHunkText: a long commit message cannot crowd out the code', () => {
  const embedder = makeFakeEmbedder({ maxInputTokens: 40 });
  const longBody = Array.from({ length: 200 }, (_, i) => `filler-word-${i}`).join(' ');
  const built = buildHunkText(
    {
      subject: 'Fix bug',
      body: longBody,
      path: { bytesBase64: Buffer.from('a.ts').toString('base64'), display: 'a.ts', lossy: false },
      oldPath: null,
      changeType: 'M',
      removedLines: ['const x = 1'],
      addedLines: ['const x = 2', 'const y = 3'],
      contextLines: ['function f() {'],
    },
    embedder,
  );
  assert.ok(built.semanticText.includes('Removed code'));
  assert.ok(built.semanticText.includes('Added code'));
  assert.ok(built.semanticText.includes('const x = 2'), 'code must survive despite a huge message');
  assert.ok(built.semanticTruncated);
});

test('buildHunkText labels removed/added code explicitly', () => {
  const embedder = makeFakeEmbedder();
  const built = buildHunkText(
    {
      subject: 'Guard null token',
      body: '',
      path: {
        bytesBase64: Buffer.from('auth.ts').toString('base64'),
        display: 'src/auth.ts',
        lossy: false,
      },
      oldPath: null,
      changeType: 'M',
      removedLines: ['throw new Error()'],
      addedLines: ['return null'],
      contextLines: [],
    },
    embedder,
  );
  assert.match(built.semanticText, /Removed code:\n.*throw new Error\(\)/s);
  assert.match(built.semanticText, /Added code:\n.*return null/s);
  assert.ok(built.semanticText.includes('src/auth.ts'));
});

test('buildCommitText caps embedded changed-path list without dropping the full catalog (caller retains that separately)', () => {
  const embedder = makeFakeEmbedder({ maxInputTokens: 1024 });
  const paths = Array.from({ length: 300 }, (_, i) => `src/file${i}.ts`);
  const built = buildCommitText(
    { subject: 'Big refactor', body: '', changedPathDisplays: paths },
    embedder,
    128,
  );
  // only up to maxChangedPaths should ever appear in the embedded text
  assert.ok(!built.semanticText.includes('src/file200.ts'));
  assert.ok(built.semanticText.includes('src/file0.ts'));
});

test('buildCommitText lexical text includes decomposed path components from changed files', () => {
  const embedder = makeFakeEmbedder();
  const built = buildCommitText(
    {
      subject: 'Update AuthSessionProvider',
      body: '',
      changedPathDisplays: ['src/auth/session.ts'],
    },
    embedder,
    128,
  );
  assert.ok(built.lexicalText.includes('AuthSessionProvider'));
  assert.ok(built.lexicalText.split(' ').includes('session'));
});
