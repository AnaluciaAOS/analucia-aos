// ULID: 48-bit millisecond time + 80 random bits, Crockford base32 (26 chars).
// Monotonic within one process: same millisecond => random part incremented.
import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let lastTime = -1;
let lastRandom = null;

function encodeTime(ms) {
  let out = '';
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[ms % 32] + out;
    ms = Math.floor(ms / 32);
  }
  return out;
}

function increment(digits) {
  const next = digits.slice();
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i] < 31) {
      next[i]++;
      return next;
    }
    next[i] = 0;
  }
  throw new Error('ULID random part overflow');
}

export function ulid(ms = Date.now()) {
  let random;
  if (ms === lastTime && lastRandom) {
    random = increment(lastRandom);
  } else {
    random = [...randomBytes(16)].map((b) => b % 32);
  }
  lastTime = ms;
  lastRandom = random;
  return encodeTime(ms) + random.map((d) => ALPHABET[d]).join('');
}
