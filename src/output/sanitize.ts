/**
 * Terminal-control-sequence sanitization. This is a security boundary: a
 * commit message, author name, path, or diff line is attacker-controlled
 * (or at least not under Git Why's control) and can contain ANSI escapes,
 * OSC 8 hyperlinks, cursor movement, or colour resets. Every repository-
 * sourced string must pass through here before it reaches a terminal.
 *
 * JSON output does NOT use this module: JSON escaping already renders
 * control characters inert without discarding data (see `output/json.ts`).
 *
 * All patterns use `\x` hex escapes rather than literal control bytes so
 * this file stays plain ASCII and diff-safe.
 */

// OSC (Operating System Command): ESC ] ... terminated by BEL or ST (ESC \).
// Covers OSC 8 hyperlinks, e.g. `\x1b]8;;https://evil\x07link text\x1b]8;;\x07`.
const OSC = /\x1b\][\s\S]*?(?:\x07|\x1b\x5c)/g;

// DCS/SOS/PM/APC: ESC P|X|^|_ ... terminated by ST (ESC \). Rare, but a
// well-formed sanitizer should not leave a live string introducer open.
const STRING_TERMINATED = /\x1b[PX^_][\s\S]*?\x1b\x5c/g;

// CSI (Control Sequence Introducer): ESC [ params intermediates final-byte.
// Covers colour (`\x1b[31m`), cursor movement (`\x1b[1;1H`), erase (`\x1b[2J`).
const CSI = /\x1b\x5b[0-9:;<=>?]*[\x20-\x2f]*[\x40-\x7e]/g;

// Charset designation, e.g. `\x1b(B`.
const CHARSET = /\x1b[()][A-Za-z0-9]/g;

// Other short escapes: reset (`\x1bc`), save/restore cursor (`\x1b7`/`\x1b8`),
// keypad modes (`\x1b=`/`\x1b>`), etc.
const SIMPLE_ESCAPE = /\x1b[0-9A-Za-z=><~]/g;

// Any escape byte not consumed above is stripped on its own as a fallback;
// it is never safe to hand a bare ESC to a terminal.
const STRAY_ESCAPE = /\x1b/g;

// Remaining C0 controls except newline (\n, \x0a) and tab (\t, \x09), plus
// all C1 controls (\x80-\x9f), which some terminals also treat as escapes.
const OTHER_CONTROL = /[\x00-\x08\x0b\x0c\x0d\x0e-\x1f\x7f\x80-\x9f]/g;

/**
 * Strips terminal control sequences from a repository-sourced string,
 * preserving ordinary displayable text (including newlines and tabs).
 */
export function sanitizeForTerminal(input: string): string {
  return input
    .replace(OSC, '')
    .replace(STRING_TERMINATED, '')
    .replace(CSI, '')
    .replace(CHARSET, '')
    .replace(SIMPLE_ESCAPE, '')
    .replace(STRAY_ESCAPE, '')
    .replace(OTHER_CONTROL, '');
}
