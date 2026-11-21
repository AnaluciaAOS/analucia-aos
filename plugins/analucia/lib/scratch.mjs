// ORD-0043 part 9 (OBS-143): copies of real data are declared when they are made and cleaned before the order is
// delivered. `aos scratch add` records, in the evidence folder of the order (scratch.json), each folder that holds
// a copy of real data and each process that serves it: names and numbers only, never content. `aos scratch check`
// passes when every recorded folder is gone and every recorded process has ended; `aos run finish --outcome done`
// calls the same function and refuses while a copy remains.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { RuleError } from './state.mjs';

const posix = (p) => resolve(p).split(sep).join('/');
export const scratchRel = (id) => `.analucia/evidence/${id}/scratch.json`;

// The recorded copies of an order: [{ path, pid, added }]. A missing file is an empty list; a file that cannot be
// read as the list this module writes is an error, never "nothing recorded".
export function readScratch(root, id) {
  const p = join(root, scratchRel(id));
  if (!existsSync(p)) return [];
  let data;
  try { data = JSON.parse(readFileSync(p, 'utf8')); } catch { data = null; }
  if (!data || !Array.isArray(data.copies) || data.copies.some((c) => !c || typeof c.path !== 'string')) {
    throw new RuleError('E_JSON', `${scratchRel(id)} is not the list "aos scratch add" writes; restore it from git or record the copies again`);
  }
  return data.copies;
}

export function scratchAdd(root, id, { path, pid = null, now = new Date() } = {}) {
  if (!existsSync(join(root, '.analucia', 'orders', `${id}.md`))) throw new RuleError('E_NO_ORDER', `no order file .analucia/orders/${id}.md`);
  if (typeof path !== 'string' || !path.trim()) throw new RuleError('E_MISSING_FIELD', '--path <folder> is required: the folder that holds the copy');
  let n = null;
  if (pid !== null && pid !== undefined) {
    if (!/^[1-9]\d*$/.test(String(pid))) throw new RuleError('E_FIELD_TYPE', `--pid ${JSON.stringify(pid)} is not a process number`);
    n = Number(pid);
  }
  const copies = readScratch(root, id);
  const at = posix(path);
  const same = (a) => (process.platform === 'win32' ? a.toLowerCase() === at.toLowerCase() : a === at);
  const known = copies.find((c) => same(c.path) && (c.pid ?? null) === n);
  if (!known) copies.push({ path: at, pid: n, added: now.toISOString() });
  const file = join(root, scratchRel(id));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ order: id, copies }, null, 2)}\n`);
  return { path: at, pid: n, added: !known, total: copies.length };
}

// A process number that still names a running process. EPERM: it exists and is another user's.
export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (x) {
    return x.code === 'EPERM';
  }
}

// { recorded, remaining: [{ kind: 'folder' | 'process', path, pid }] }: what is still there.
export function scratchCheck(root, id) {
  const copies = readScratch(root, id);
  const remaining = [];
  for (const c of copies) {
    if (existsSync(c.path)) remaining.push({ kind: 'folder', path: c.path, pid: c.pid ?? null });
    if (c.pid && processAlive(c.pid)) remaining.push({ kind: 'process', path: c.path, pid: c.pid });
  }
  return { recorded: copies.length, remaining };
}

export const remainingLine = (r) => (r.kind === 'folder' ? `folder still there: ${r.path}` : `process still running: ${r.pid} (serves ${r.path})`);
