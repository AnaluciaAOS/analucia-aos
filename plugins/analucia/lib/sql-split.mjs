// ORD-0047 part 5 (OBS-207): split a SQL file into statements without being fooled by semicolons inside `--` and
// `/* */` comments, quoted strings ('..', "..") and dollar-quoted bodies ($$..$$, $tag$..$tag$). Reads one file;
// never connects to anything.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The statements of `sql` (text), each trimmed, without the closing ";" and without empty ones.
export function splitSql(sql) {
  const out = [];
  let cur = '';
  let i = 0;
  const n = sql.length;
  const push = () => { if (cur.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '').trim() !== '') out.push(cur.trim()); cur = ''; };
  while (i < n) {
    const c = sql[i];
    const two = sql.slice(i, i + 2);
    if (two === '--') { const e = sql.indexOf('\n', i); const j = e === -1 ? n : e; cur += sql.slice(i, j); i = j; continue; }
    if (two === '/*') {
      let depth = 1; let j = i + 2;
      while (j < n && depth > 0) { if (sql.slice(j, j + 2) === '/*') { depth += 1; j += 2; } else if (sql.slice(j, j + 2) === '*/') { depth -= 1; j += 2; } else j += 1; }
      cur += sql.slice(i, j); i = j; continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n) { if (sql[j] === c) { if (sql[j + 1] === c) { j += 2; continue; } break; } j += 1; }
      cur += sql.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length);
        const j = end === -1 ? n : end + m[0].length;
        cur += sql.slice(i, j); i = j; continue;
      }
    }
    if (c === ';') { push(); i += 1; continue; }
    cur += c; i += 1;
  }
  push();
  return out;
}

// The first line of a statement that is not a comment, shortened.
export const firstLine = (stmt) => {
  const l = stmt.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((s) => s.trim()).find((s) => s !== '' && !s.startsWith('--')) ?? '';
  return l.length > 100 ? `${l.slice(0, 97)}...` : l;
};

// { ok, count, statements: [first line], line } for a file; the file is only read.
export function sqlSplit(root, file) {
  const path = resolve(root, file);
  if (!existsSync(path)) return { ok: false, count: 0, statements: [], line: `sql split: the file ${file} does not exist` };
  const stmts = splitSql(readFileSync(path, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n'));
  return { ok: stmts.length > 0, count: stmts.length, statements: stmts.map(firstLine), line: `sql split: ${stmts.length} statement(s) in ${file}` };
}
