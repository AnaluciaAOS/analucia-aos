// Director lock (SPEC-0002 §2): every director file must match its sha256, computed with line endings normalized to LF.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from './validate.mjs';

export const LOCK_REL = '.analucia/director.lock';

// CRLF -> LF on the raw bytes, so a CRLF checkout of a director file does not count as a change.
export function hashLF(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i++) if (!(bytes[i] === 0x0d && bytes[i + 1] === 0x0a)) out.push(bytes[i]);
  return sha256Hex(Buffer.from(out));
}

export function readLock(root) {
  const p = join(root, LOCK_REL);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

// Returns [{ path, problem }] for every locked file that is missing or differs. Empty array = intact.
export function checkLock(root) {
  const lock = readLock(root);
  if (!lock) return [{ path: LOCK_REL, problem: 'missing' }];
  const changed = [];
  for (const [path, expected] of Object.entries(lock.files ?? {})) {
    const abs = join(root, path);
    if (!existsSync(abs)) changed.push({ path, problem: 'missing' });
    else if (hashLF(readFileSync(abs)) !== expected) changed.push({ path, problem: 'changed' });
  }
  return changed;
}

// Repo-relative director paths: the files in the lock plus the lock itself.
export function lockedPaths(root) {
  const lock = readLock(root);
  return [LOCK_REL, ...Object.keys(lock?.files ?? {})];
}
