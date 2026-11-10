// ORD-0029 A: the SessionStart hook says, in every case, where it found the project root (or that it found none).
import { resolve, sep } from 'node:path';
import { aosCommand } from './cli.mjs';
import { personLocale } from './locale.mjs';
import { catalog } from './onboarding.mjs';

const posix = (p) => resolve(p).split(sep).join('/');

// The owner's language: the one fallback of lib/locale.mjs (ORD-0033 B.3), the same as the CLI's.
export function sessionLocale(root) {
  return personLocale(root);
}

// No .analucia/ in the session folder or any folder above it.
export function notInitialisedLine(cwd) {
  const t = catalog(sessionLocale(null));
  return t('session.not_initialised', { cwd: posix(cwd), cmd: `${aosCommand()} init` });
}

// The root line, printed right after the Status line; it names the session folder when it is a subfolder.
export function rootLine(root, cwd) {
  const t = catalog(sessionLocale(root));
  const r = posix(root);
  const c = cwd ? posix(cwd) : r;
  const same = process.platform === 'win32' ? r.toLowerCase() === c.toLowerCase() : r === c;
  return same ? t('session.root', { root: r }) : t('session.root_sub', { root: r, cwd: c });
}

// Inserts the root line after the first line of the SessionStart output.
export function withRootLine(text, root, cwd) {
  const [first, ...rest] = text.split('\n');
  return [first, rootLine(root, cwd), ...rest].join('\n');
}
