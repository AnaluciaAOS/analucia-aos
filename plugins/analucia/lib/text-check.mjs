// ORD-0047 part 4 (OBS-206): `aos text has|lacks <file> "<text>" [--ignore-case]`, a text check that is safe with
// accents (UTF-8, compared in NFC), the standard for every text check of a verify file. grep gave false alarms on text
// with accents in Git Bash.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// { ok, line }: has -> ok when the text is in the file; lacks -> ok when it is not.
export function textCheck(root, mode, file, text, { ignoreCase = false } = {}) {
  const path = resolve(root, file);
  if (!existsSync(path)) return { ok: false, line: `text ${mode}: the file ${file} does not exist` };
  const norm = (s) => { const n = s.normalize('NFC'); return ignoreCase ? n.toLowerCase() : n; };
  const body = norm(readFileSync(path, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n'));
  const present = body.includes(norm(text));
  const ok = mode === 'has' ? present : !present;
  return { ok, line: `text ${mode}: ${ok ? 'ok' : 'FAIL'} (${JSON.stringify(text)} is ${present ? 'in' : 'not in'} ${file})` };
}
