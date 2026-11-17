// Earlier records of an adopted project (ORD-0041 part 2, AMD-0015 §3). A project that already runs often has its
// own orders, reports and decisions. The adoption audit lists those folders, by folder and file names only (never
// file content), and `aos docs check <order ID>` fails when a commit of the order adds one more file inside such a
// folder that neither the order nor one of its amendments names by its path.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The one list of folder names that hold earlier records (compared without case).
export const EARLIER_FOLDER_NAMES = [
  'orders', 'order', 'ordenes', 'órdenes', 'work-orders', 'workorders', 'ordenes-de-trabajo',
  'tickets', 'tasks', 'tareas', 'issues', 'backlog',
  'reports', 'reportes', 'informes', 'minutes', 'actas',
  'decisions', 'decisiones', 'adr', 'adrs', 'rfc', 'rfcs',
];
// The one list of words that start the name of a numbered record file (OT-012, ADR-0001, TICKET-101).
export const EARLIER_RECORD_WORDS = ['ORD', 'ORDEN', 'ORDER', 'OT', 'WO', 'TASK', 'TAREA', 'TICKET', 'ISSUE', 'DEC', 'DECISION', 'ADR', 'RFC', 'REPORT', 'REPORTE', 'INFORME', 'ACTA'];
// A folder of records by its file names alone needs at least this many numbered files.
export const MIN_NUMBERED_FILES = 5;
// Folders of code, of dependencies and of the Loop itself are never earlier records.
const CODE_SEGMENTS = new Set(['src', 'lib', 'app', 'apps', 'server', 'client', 'components', 'pages', 'api', 'test', 'tests', '__tests__', 'spec', 'packages', 'node_modules', 'vendor', 'dist', 'build', '.git', '.analucia', '.github', '.claude']);
// OT-012-x.md, ADR_0001.md, TICKET 101.txt; a date (informe-2026-01) is not a number of a record.
const NUMBERED_RE = /^([A-Za-zÁÉÍÓÚáéíóúÑñ]{2,10})[-_ ]?(\d{2,6})(?!\d|[-_.]\d)/;

function numberOf(name) {
  const m = NUMBERED_RE.exec(name);
  return m && EARLIER_RECORD_WORDS.includes(m[1].toUpperCase()) ? { prefix: m[1].toUpperCase(), digits: m[2] } : null;
}

// files: repo-relative paths with "/" (the tracked files). Returns [{ folder, files, numbering: [{ prefix, count,
// first, last }] }] sorted by folder.
export function detectEarlierRecords(files) {
  const byFolder = new Map();
  const add = (folder, file) => { if (!byFolder.has(folder)) byFolder.set(folder, []); byFolder.get(folder).push(file); };
  const loose = new Map(); // parent folder -> its numbered files, for folders whose name tells nothing
  for (const f of files) {
    const parts = f.split('/');
    const dirs = parts.slice(0, -1);
    if (!dirs.length || dirs.some((d) => CODE_SEGMENTS.has(d.toLowerCase()))) continue;
    const i = dirs.findIndex((d) => EARLIER_FOLDER_NAMES.includes(d.toLowerCase()));
    if (i !== -1) add(dirs.slice(0, i + 1).join('/'), f);
    else if (numberOf(parts.at(-1))) {
      const parent = dirs.join('/');
      if (!loose.has(parent)) loose.set(parent, []);
      loose.get(parent).push(f);
    }
  }
  for (const [folder, numbered] of loose) {
    if (numbered.length >= MIN_NUMBERED_FILES) for (const f of files.filter((x) => x.startsWith(`${folder}/`) && !x.slice(folder.length + 1).includes('/'))) add(folder, f);
  }
  return [...byFolder.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([folder, list]) => {
    const groups = new Map();
    for (const f of list) {
      const n = numberOf(f.split('/').at(-1));
      if (!n) continue;
      if (!groups.has(n.prefix)) groups.set(n.prefix, []);
      groups.get(n.prefix).push(n.digits);
    }
    const numbering = [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([prefix, digits]) => {
      const sorted = [...digits].sort((a, b) => Number(a) - Number(b));
      return { prefix, count: digits.length, first: sorted[0], last: sorted.at(-1) };
    });
    return { folder, files: list.length, numbering };
  });
}

const git = (root, args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
export const trackedFiles = (root) => git(root, ['ls-files', '-z']).stdout.split('\0').filter(Boolean);

// The text that may name a path: the order file and every amendment whose `amends` names the order.
function orderTexts(root, id) {
  const texts = [];
  const order = join(root, '.analucia', 'orders', `${id}.md`);
  if (existsSync(order)) texts.push(readFileSync(order, 'utf8'));
  const dir = join(root, '.analucia', 'amendments');
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.md'))) {
      const text = readFileSync(join(dir, f), 'utf8');
      const amends = /^amends:\s*(.+)$/m.exec(text)?.[1] ?? '';
      if (amends.split(/[\s,[\]]+/).includes(id)) texts.push(text);
    }
  }
  return texts.join('\n');
}

// aos docs check <ID>: { folders, commits, added, unnamed }. `unnamed` are the files added by commits of the order
// inside a folder of earlier records that neither the order nor one of its amendments names by its path.
export function docsCheck(root, id) {
  const earlier = detectEarlierRecords(trackedFiles(root));
  if (!earlier.length) return { folders: 0, commits: 0, added: 0, unnamed: [] };
  const pattern = `^Analucia-Order: ${id.replace(/[.]/g, '\\.')}$`;
  const commits = git(root, ['log', '--format=%H', `--grep=${pattern}`]).stdout.split('\n').filter(Boolean);
  const added = new Set();
  for (const sha of commits) {
    for (const f of git(root, ['diff-tree', '--no-commit-id', '--name-only', '--diff-filter=A', '-r', '--root', sha]).stdout.split('\n').filter(Boolean)) {
      if (earlier.some((e) => f.startsWith(`${e.folder}/`))) added.add(f);
    }
  }
  const text = orderTexts(root, id);
  const unnamed = [...added].filter((f) => !text.includes(f)).sort();
  return { folders: earlier.length, commits: commits.length, added: added.size, unnamed };
}
