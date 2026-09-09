// Deterministic PRNG utilities. Every fixture history must be reproducible
// from a string seed alone -- no wall-clock time, no OS randomness, no
// dependency on iteration order of Object/Map (we only ever iterate arrays).

import { createHash } from 'node:crypto';

/** Derive a 32-bit unsigned integer seed from an arbitrary string. */
export function seedFromString(text) {
  const digest = createHash('sha256').update(text, 'utf8').digest();
  return digest.readUInt32LE(0);
}

/**
 * mulberry32: small, fast, deterministic PRNG. Good enough for fixture
 * generation (not for anything security-sensitive).
 */
export function mulberry32(seedInt) {
  let a = seedInt >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Create a named sub-RNG derived from a parent seed string + label, so
 * independent concerns (file content vs. ordering vs. word choice) don't
 * accidentally correlate. */
export function subRng(parentSeed, label) {
  return mulberry32(seedFromString(`${parentSeed}::${label}`));
}

export function randInt(rng, minInclusive, maxInclusive) {
  return minInclusive + Math.floor(rng() * (maxInclusive - minInclusive + 1));
}

export function pick(rng, array) {
  if (array.length === 0) throw new Error('pick: empty array');
  return array[randInt(rng, 0, array.length - 1)];
}

export function pickMany(rng, array, count) {
  const pool = array.slice();
  const out = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const idx = randInt(rng, 0, pool.length - 1);
    out.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return out;
}

/** Fisher-Yates shuffle using the supplied deterministic RNG. */
export function shuffle(rng, array) {
  const out = array.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = randInt(rng, 0, i);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
