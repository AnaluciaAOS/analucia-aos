// A prompt of another project is refused (ORD-0042 part 8, OBS-152). The prompt hook reads the prompt and adds one
// line of context for the session, never blocking the prompt itself, in three cases:
//   1. the prompt names a record ID that carries the code of another project registered on this computer;
//   2. it names a record ID (an order, an amendment or an ask) that does not exist in this project;
//   3. it starts with a line `Project: <name>` and the name is neither the code nor the folder name of this project.
// Nothing is read outside the project folder except the list of codes the tool already keeps.
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { claudeConfigDir } from './cli.mjs';
import { parseId, projectCode, readCodes } from './ids.mjs';

const posix = (p) => resolve(p).split(sep).join('/');
const sameFolder = (a, b) => (process.platform === 'win32' ? posix(a).toLowerCase() === posix(b).toLowerCase() : posix(a) === posix(b));
// Tokens that have the shape of a record ID of an order, an amendment or an ask, in either form.
const ID_RE = /(?<![\w-])(?:[A-Z]{2,5}-(?:AMD|ASK)-\d{4}|[A-Z]{2,5}-\d{4}(?:\.[A-Z])?)(?![\w-])/g;
const FOLDER_OF = { order: ['orders', 'drafts'], amendment: ['amendments'], ask: ['asks'] };

function existsHere(root, id, kind, known) {
  if (known.has(id)) return true;
  return FOLDER_OF[kind].some((d) => existsSync(join(root, '.analucia', d, `${id}.md`)) || existsSync(join(root, '.analucia', d, `${id}.json`)));
}

// null, or { case: 1 | 2 | 3, key, vars } for the catalog line.
export function wrongProjectNote(root, prompt, { configDir = claudeConfigDir() } = {}) {
  if (typeof prompt !== 'string' || !prompt.trim()) return null;
  const code = projectCode(root);
  const folder = basename(resolve(root));
  // 3. the first line names a project
  const first = /^\s*Project:[ \t]*(.+?)[ \t]*(?:\r?\n|$)/.exec(prompt);
  if (first) {
    const name = first[1].trim();
    const mine = [code, folder].filter(Boolean).map((s) => s.toLowerCase());
    if (!mine.includes(name.toLowerCase())) return { case: 3, key: 'hook.wrong_project.named', vars: { name, project: code ?? folder, folder: posix(root) } };
  }
  const ids = [...new Set(prompt.match(ID_RE) ?? [])].map((id) => ({ id, p: parseId(id) })).filter((x) => x.p && FOLDER_OF[x.p.kind]);
  if (!ids.length) return null;
  const codes = readCodes(configDir);
  // 1. a record that carries the code of another project of this computer
  for (const { id, p } of ids) {
    if (!p.code || p.code === code) continue;
    const where = codes[p.code];
    if (typeof where === 'string' && !sameFolder(where, root)) return { case: 1, key: 'hook.wrong_project.code', vars: { id, code: p.code, folder: where } };
  }
  // 2. a record of this project's numbering that does not exist here. A token with a prefix that is no project's
  //    code (ISO-8601, RFC-2119) is not a record and is not judged.
  let known = new Set();
  try {
    known = new Set(readFileSync(join(root, '.analucia', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l).subject; } catch { return null; } }).filter(Boolean));
  } catch { /* no log: only the files count */ }
  for (const { id, p } of ids) {
    if (p.code && p.code !== code) continue;
    if (!existsHere(root, id, p.kind, known)) return { case: 2, key: 'hook.wrong_project.missing', vars: { id } };
  }
  return null;
}
