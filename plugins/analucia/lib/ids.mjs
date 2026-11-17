// Record IDs and the project code (ORD-0041 part 1, AMD-0015 §1).
// A project may have a code: 2 to 5 capital letters in project.json (`project_code`), unique among the projects of
// the computer and never one of the type words. In a project with a code, new records are numbered <CODE>-NNNN
// (orders), <CODE>-AMD-NNNN (amendments) and <CODE>-ASK-NNNN (asks); each counter continues from the highest number
// the project already has. Every ID that exists stays as it is and stays valid: nothing here renames anything.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { claudeConfigDir } from './cli.mjs';
import { ASK_ID_RE, CODE_PATTERN, ORDER_ID_RE, TYPE_WORDS, enums } from './enums.mjs';

export { TYPE_WORDS };
const CODE_RE = /^[A-Z]{2,5}$/;
const posix = (p) => resolve(p).split(sep).join('/');
const pad = (n) => String(n).padStart(4, '0');

// null when `code` can be a project code, else which rule it breaks: 'format' or 'type_word'.
export function codeProblemKey(code) {
  if (typeof code !== 'string' || !CODE_RE.test(code)) return 'format';
  return TYPE_WORDS.includes(code) ? 'type_word' : null;
}
export function codeProblem(code) {
  const k = codeProblemKey(code);
  if (!k) return null;
  return k === 'type_word' ? `${code} is a type word (${TYPE_WORDS.join(', ')}) and cannot be a project code` : `${JSON.stringify(code)} is not a project code: 2 to 5 capital letters`;
}

// The code of the project, or null (no project.json, no code, or a code that is not valid).
export function projectCode(root) {
  try {
    const code = JSON.parse(readFileSync(join(root, '.analucia', 'project.json'), 'utf8')).project_code;
    return codeProblemKey(code) ? null : code;
  } catch {
    return null;
  }
}

// ---------- reading an ID ----------

const KIND_OF = Object.fromEntries(Object.entries(enums.record_id_prefixes).map(([kind, prefix]) => [prefix, kind]));
const OLD_RE = new RegExp(`^(${Object.keys(KIND_OF).join('|')})-(\\d{4})(?:\\.([A-Z]))?$`);
const CODED_RE = new RegExp(`^(${CODE_PATTERN})-(?:(AMD|ASK)-)?(\\d{4})(?:\\.([A-Z]))?$`);

// { kind, code, number, phase } or null. `code` is null for the forms without a project code. Only orders have phases.
export function parseId(id) {
  if (typeof id !== 'string') return null;
  let m = OLD_RE.exec(id);
  if (m) return m[3] && m[1] !== 'ORD' ? null : { kind: KIND_OF[m[1]], code: null, number: Number(m[2]), phase: m[3] ?? null };
  m = CODED_RE.exec(id);
  if (!m) return null;
  if (m[2] && m[4]) return null;
  return { kind: m[2] ? KIND_OF[m[2]] : 'order', code: m[1], number: Number(m[3]), phase: m[4] ?? null };
}
export const isOrderId = (id) => typeof id === 'string' && ORDER_ID_RE.test(id);
export const isAskId = (id) => typeof id === 'string' && ASK_ID_RE.test(id);
export const isAmendmentId = (id) => parseId(id)?.kind === 'amendment';

// The ID of `kind` with `number` (and phase) as this project writes it: under its code, or the old form without one.
export function formatId(kind, number, { code = null, phase = null } = {}) {
  const tail = `${pad(number)}${phase ? `.${phase}` : ''}`;
  if (kind === 'order') return `${code ?? 'ORD'}-${tail}`;
  const word = enums.record_id_prefixes[kind];
  return code ? `${code}-${word}-${tail}` : `${word}-${tail}`;
}

// ---------- counters ----------

const readEvents = (root) => {
  try {
    return readFileSync(join(root, '.analucia', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const filesOf = (root, dir) => {
  const p = join(root, '.analucia', dir);
  return existsSync(p) ? readdirSync(p).map((f) => f.replace(/\.(md|json)$/, '')) : [];
};

// Every ID of `kind` the project has, in any form: files of its folder (drafts too, for orders) and the log.
export function existingIds(root, kind, { events = readEvents(root) } = {}) {
  const code = projectCode(root);
  const ids = new Set();
  const add = (id) => { if (parseId(id)?.kind === kind) ids.add(id); };
  if (kind === 'order') {
    filesOf(root, 'orders').forEach(add);
    // A draft with the old prefix in a project with a code is refused, so it holds no number.
    filesOf(root, 'drafts').filter((id) => !(code && parseId(id)?.code === null)).forEach(add);
  } else if (kind === 'amendment') filesOf(root, 'amendments').forEach(add);
  else if (kind === 'ask') filesOf(root, 'asks').forEach(add);
  for (const e of events) {
    add(e.subject);
    if (kind === 'amendment') add(e.payload?.amendment);
  }
  return [...ids];
}

// The next free ID of a kind: one more than the highest number the project has, under its code when it has one.
export function nextId(root, kind, { events } = {}) {
  const numbers = existingIds(root, kind, events ? { events } : {}).map((id) => parseId(id).number);
  return formatId(kind, Math.max(0, ...numbers) + 1, { code: projectCode(root) });
}

// ---------- the prefix a record of this project may carry ----------

const CODED_KINDS = new Set(['order', 'amendment', 'ask']);

// null when `id` may be a record of this project, else one sentence that gives the ID to use.
// `exists`: the record is already in the log (an existing ID is valid for ever, whatever its prefix).
export function prefixProblem(root, id, { exists = false } = {}) {
  const p = parseId(id);
  if (!p || !CODED_KINDS.has(p.kind) || exists) return null;
  const code = projectCode(root);
  if (p.code && p.code !== code) {
    return code
      ? `${id} carries the prefix ${p.code}, but the code of this project is ${code}: use ${formatId(p.kind, p.number, { code, phase: p.phase })}`
      : `${id} carries the prefix ${p.code}, but this project has no code: use ${formatId(p.kind, p.number, { phase: p.phase })}, or let the owner choose the code with INICIAR`;
  }
  if (!p.code && code) return `${id} is a new record with the old prefix, and this project has the code ${code}: use ${formatId(p.kind, p.number, { code, phase: p.phase })}`;
  return null;
}

// ---------- unique on the computer ----------

// The list of codes and project folders, in Claude Code's configuration folder (CLAUDE_CONFIG_DIR is honoured).
export const codesPath = (configDir = claudeConfigDir()) => join(configDir, 'analucia', 'project-codes.json');
export function readCodes(configDir = claudeConfigDir()) {
  try {
    const codes = JSON.parse(readFileSync(codesPath(configDir), 'utf8')).codes;
    return codes && typeof codes === 'object' ? codes : {};
  } catch {
    return {};
  }
}
const sameFolder = (a, b) => (process.platform === 'win32' ? posix(a).toLowerCase() === posix(b).toLowerCase() : posix(a) === posix(b));

// The folder of another project that uses `code` now, or null. An entry whose folder is gone, or whose project no
// longer carries the code, does not keep it.
export function codeTakenBy(root, code, configDir = claudeConfigDir()) {
  const folder = readCodes(configDir)[code];
  if (typeof folder !== 'string' || sameFolder(folder, root)) return null;
  return projectCode(folder) === code ? folder : null;
}

export function registerCode(root, code, configDir = claudeConfigDir()) {
  const codes = readCodes(configDir);
  if (typeof codes[code] === 'string' && sameFolder(codes[code], root)) return false;
  codes[code] = posix(root);
  mkdirSync(join(configDir, 'analucia'), { recursive: true });
  writeFileSync(codesPath(configDir), `${JSON.stringify({ codes: Object.fromEntries(Object.entries(codes).sort(([a], [b]) => (a < b ? -1 : 1))) }, null, 2)}\n`);
  return true;
}

// ---------- aos ids: the map for people ----------

// { code, records: [{ id, kind, under_code }], next: { order, amendment, ask } }. Reads only; renames nothing.
export function idsMap(root) {
  const code = projectCode(root);
  const events = readEvents(root);
  const records = [];
  for (const kind of ['order', 'amendment', 'ask']) {
    const ids = (kind === 'order' ? existingIds(root, kind, { events }).filter((id) => !existsSync(join(root, '.analucia', 'drafts', `${id}.md`)) || existsSync(join(root, '.analucia', 'orders', `${id}.md`))) : existingIds(root, kind, { events }));
    const sorted = ids.map((id) => ({ id, p: parseId(id) })).sort((a, b) => a.p.number - b.p.number || (a.id < b.id ? -1 : 1));
    for (const { id, p } of sorted) records.push({ id, kind, under_code: code ? formatId(kind, p.number, { code, phase: p.phase }) : id });
  }
  return { code, records, next: Object.fromEntries(['order', 'amendment', 'ask'].map((k) => [k, nextId(root, k, { events })])) };
}
