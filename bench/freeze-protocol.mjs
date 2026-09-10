// Derives bench/protocol.json's protocolHash from the protocol's own content.
//
// The v1 hash was a literal string with no generator, so nothing could tell
// whether it still described the file it sat in. A protocol hash that cannot
// be re-derived is decoration: its entire job is to make "the protocol was
// changed after the held-out run" detectable.
//
//   node bench/freeze-protocol.mjs           # verify, exit 1 on mismatch
//   node bench/freeze-protocol.mjs --write   # re-derive and write
//
// Re-deriving is a deliberate act. It invalidates every prior held-out result
// recorded against the old hash, which is the point.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PROTOCOL_PATH = fileURLToPath(new URL('./protocol.json', import.meta.url));

/**
 * Key order in JSON is not semantic, but it does change a byte hash, so keys
 * are sorted before hashing. Otherwise a formatter could silently "invalidate"
 * a protocol that nobody edited.
 */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

export function deriveProtocolHash(protocol) {
  // The hash covers everything except itself.
  const rest = { ...protocol };
  delete rest.protocolHash;
  const digest = createHash('sha256')
    .update(JSON.stringify(canonical(rest)))
    .digest('hex');
  return `sha256:${digest}`;
}

const protocol = JSON.parse(readFileSync(PROTOCOL_PATH, 'utf8'));
const derived = deriveProtocolHash(protocol);

if (process.argv.includes('--write')) {
  protocol.protocolHash = derived;
  writeFileSync(PROTOCOL_PATH, `${JSON.stringify(protocol, null, 2)}\n`);
  console.log(`protocol v${protocol.protocolVersion} frozen: ${derived}`);
} else if (protocol.protocolHash !== derived) {
  console.error(
    `protocol.json has been edited since it was frozen.\n` +
      `  recorded: ${protocol.protocolHash}\n` +
      `  derived:  ${derived}\n` +
      `Bump protocolVersion and re-run with --write. Prior held-out results ` +
      `recorded against the old hash do not carry over.`,
  );
  process.exit(1);
} else {
  console.log(`protocol v${protocol.protocolVersion} matches its hash: ${derived}`);
}
