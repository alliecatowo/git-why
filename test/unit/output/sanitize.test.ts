import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sanitizeForTerminal } from '../../../src/output/sanitize.js';

test('SGR colour codes are stripped', () => {
  assert.equal(sanitizeForTerminal('\x1b[31mred\x1b[0m plain'), 'red plain');
});

test('cursor movement and screen erase are stripped', () => {
  assert.equal(sanitizeForTerminal('a\x1b[1;1Hb\x1b[2Jc'), 'abc');
});

test('an OSC 8 hyperlink is stripped entirely, including the URL', () => {
  const input = 'click \x1b]8;;https://evil.example/steal\x07here\x1b]8;;\x07 now';
  assert.equal(sanitizeForTerminal(input), 'click here now');
});

test('an OSC 8 hyperlink terminated with ST (ESC \\\\) instead of BEL is also stripped', () => {
  const input = 'click \x1b]8;;https://evil.example\x1b\\here\x1b]8;;\x1b\\ now';
  assert.equal(sanitizeForTerminal(input), 'click here now');
});

test('a bare BEL is stripped', () => {
  assert.equal(sanitizeForTerminal('bell\x07here'), 'bellhere');
});

test('carriage return (overwrite trick) is stripped', () => {
  assert.equal(
    sanitizeForTerminal('progress: 100%\rprogress: 0% (fake)'),
    'progress: 100%progress: 0% (fake)',
  );
});

test('a simple escape sequence (terminal reset) is stripped', () => {
  assert.equal(sanitizeForTerminal('before\x1bcafter'), 'beforeafter');
});

test('charset designation escapes are stripped', () => {
  assert.equal(sanitizeForTerminal('a\x1b(Bb'), 'ab');
});

test('newlines and tabs are preserved for multi-line message bodies', () => {
  assert.equal(
    sanitizeForTerminal('line one\n\tindented line two'),
    'line one\n\tindented line two',
  );
});

test('ordinary text with no control sequences is unchanged', () => {
  const text = 'Fix infinite token-refresh loop (see src/auth/refresh.ts:72)';
  assert.equal(sanitizeForTerminal(text), text);
});

test('C1 control characters are stripped', () => {
  assert.equal(sanitizeForTerminal('a\x80\x9fb'), 'ab');
});

test('a lone, unterminated escape byte is stripped rather than left dangling', () => {
  assert.equal(sanitizeForTerminal('trailing\x1b'), 'trailing');
});

test('an attempted DCS/APC injection is stripped', () => {
  assert.equal(sanitizeForTerminal('a\x1bPmalicious\x1b\\b'), 'ab');
});

test('adjacent escape sequences with no surrounding text collapse to empty', () => {
  assert.equal(sanitizeForTerminal('\x1b[31m\x1b[1m\x1b[0m'), '');
});

test('sanitization is idempotent', () => {
  const input = 'red \x1b[31mtext\x1b[0m and \x1b]8;;http://x\x07link\x1b]8;;\x07';
  const once = sanitizeForTerminal(input);
  const twice = sanitizeForTerminal(once);
  assert.equal(once, twice);
});
