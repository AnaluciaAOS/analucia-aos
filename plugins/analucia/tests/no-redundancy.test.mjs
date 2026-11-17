// ORD-0041 part 2 (AMD-0015 §2, §3): no redundancy in an adopted project. `aos adopt` detects folders of earlier
// records (orders, reports, decisions) by folder and file names and lists them with counts and the numbering found;
// an order may say which earlier record it continues (`continues:`), shown in the queue, in `aos next` and in the
// owner sheet; `aos docs check <ID>` fails when a commit of the order adds a file inside such a folder that neither
// the order nor one of its amendments names by its path. Names only: never a secret, never file content.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { reportText, runAudit } from '../lib/adopt.mjs';
import { blockTemplate } from '../lib/guards.mjs';
import { EARLIER_FOLDER_NAMES, EARLIER_RECORD_WORDS, detectEarlierRecords, docsCheck } from '../lib/earlier-records.mjs';
import { hashLF } from '../lib/lock.mjs';
import { appendEvent, logPath } from '../lib/log.mjs';
import { nextLine } from '../lib/next.mjs';
import { buildQueue, queueText } from '../lib/queue.mjs';
import { replay } from '../lib/state.mjs';
import { readWorkbook } from '../lib/xlsx.mjs';
import { validateOrderText } from '../lib/validate.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
delete env.CLAUDE_PROJECT_DIR;
const aos = (root, args) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input: '', env });
const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' });
const write = (root, rel, text = 'x\n') => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
const order = (id, extra = []) => ['---', `id: ${id}`, `title: Title of ${id}`, 'kind: fix', 'created: 2026-11-14', 'budget_max_minutes: 30', 'budget_max_attempts: 2', 'risk: low', 'cost_effect: none', ...extra, '---', '', 'Work.', '', '## Acceptance criteria', '', '- [ ] x', ''].join('\n');

// A project that already runs: its own orders (numbered OT-…), reports and decisions, plus code.
function adopted({ withLoop = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aos-earlier-'));
  git(root, 'init', '-q', '-b', 'main');
  for (let i = 1; i <= 12; i++) write(root, `docs/ordenes/OT-${String(i).padStart(3, '0')}-tarea.md`);
  write(root, 'docs/ordenes/LEEME.md');
  for (const n of ['2026-01', '2026-02', '2026-03']) write(root, `informes/informe-${n}.md`);
  write(root, 'docs/decisions/ADR-0001-database.md');
  write(root, 'docs/decisions/ADR-0002-hosting.md');
  for (let i = 1; i <= 6; i++) write(root, `notas/TICKET-${100 + i}.txt`); // no telling folder name: the file names tell
  write(root, 'src/orders/handler.js', 'export const x = 1;\n'); // code, not records
  write(root, 'src/index.js', 'export const y = 2;\n');
  write(root, 'README.md', '# shop\n');
  if (withLoop) {
    const a = join(root, '.analucia');
    for (const d of ['orders', 'verify', 'evidence', 'amendments']) mkdirSync(join(a, d), { recursive: true });
    writeFileSync(join(a, 'project.json'), '{"wip_limit":2,"locale":"en"}\n');
    writeFileSync(logPath(root), '');
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'before the Loop');
  return root;
}
function place(root, id, text) {
  writeFileSync(join(root, '.analucia', 'orders', `${id}.md`), text);
  writeFileSync(join(root, '.analucia', 'verify', `${id}.json`), JSON.stringify({ order: id, checks: [{ name: 'c', run: 'exit 0', expect_exit: 0 }] }));
  const files = {};
  for (const rel of [`.analucia/orders/${id}.md`, `.analucia/verify/${id}.json`]) files[rel] = hashLF(readFileSync(join(root, rel)));
  writeFileSync(join(root, '.analucia', 'director.lock'), JSON.stringify({ files }));
  appendEvent(root, { type: 'record.created', actor: 'director', subject: id });
  appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: id, payload: { from: 'draft', to: 'ready' } });
  appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: id, payload: { from: 'ready', to: 'queued' } });
}
const commit = (root, message) => { git(root, 'add', '-A'); assert.equal(git(root, 'commit', '-q', '-m', message).status, 0); };

test('the patterns are one constant each, and they tell records from code', () => {
  for (const name of ['orders', 'ordenes', 'órdenes', 'reports', 'informes', 'reportes', 'decisions', 'decisiones', 'adr', 'tickets', 'tareas']) assert.ok(EARLIER_FOLDER_NAMES.includes(name), name);
  for (const word of ['ORD', 'OT', 'ORDEN', 'ADR', 'DEC', 'TICKET', 'INFORME', 'REPORT']) assert.ok(EARLIER_RECORD_WORDS.includes(word), word);
  const found = detectEarlierRecords(['src/orders/handler.js', 'lib/reports/build.mjs', 'app/tickets/page.tsx', 'README.md', '.analucia/orders/ORD-0001.md', 'node_modules/x/orders/a.md']);
  assert.deepEqual(found, [], 'folders of code, the Loop own folder and dependencies are not earlier records');
});

test('aos adopt lists the folders of earlier records with counts and the numbering found, under their own heading', () => {
  const root = adopted();
  const audit = runAudit(root);
  assert.deepEqual(audit.earlier.map((e) => [e.folder, e.files]), [['docs/decisions', 2], ['docs/ordenes', 13], ['informes', 3], ['notas', 6]]);
  const ordenes = audit.earlier.find((e) => e.folder === 'docs/ordenes');
  assert.deepEqual(ordenes.numbering, [{ prefix: 'OT', count: 12, first: '001', last: '012' }]);
  assert.deepEqual(audit.earlier.find((e) => e.folder === 'docs/decisions').numbering, [{ prefix: 'ADR', count: 2, first: '0001', last: '0002' }]);
  assert.deepEqual(audit.earlier.find((e) => e.folder === 'notas').numbering, [{ prefix: 'TICKET', count: 6, first: '101', last: '106' }]);
  assert.deepEqual(audit.earlier.find((e) => e.folder === 'informes').numbering, []);
  const text = reportText(audit, 'en');
  assert.match(text, /## Earlier records of this project \(4 folder\(s\), 24 file\(s\)\)/);
  assert.match(text, /- docs\/ordenes: 13 file\(s\); numbering found: OT 001 to 012 \(12\)/);
  assert.match(text, /- informes: 3 file\(s\); no numbering found in the file names/);
  assert.match(text, /Question for the owner: how do new orders link to these records\?/);
  assert.ok(text.indexOf('## Earlier records') < text.indexOf('## Proposed orders'));
  // Names only, read-only: the command changes no tracked file, and a project without such folders says so.
  const before = git(root, 'status', '--porcelain').stdout;
  const cli = aos(root, ['adopt', '--locale', 'en']);
  assert.match(cli.stdout, /## Earlier records of this project \(4 folder\(s\), 24 file\(s\)\)/);
  assert.equal(git(root, 'status', '--porcelain', '--', 'docs', 'informes', 'notas', 'src').stdout, before);
  const plain = mkdtempSync(join(tmpdir(), 'aos-earlier-none-'));
  git(plain, 'init', '-q', '-b', 'main');
  write(plain, 'src/index.js');
  git(plain, 'add', '-A');
  git(plain, 'commit', '-q', '-m', 'x');
  assert.match(reportText(runAudit(plain), 'en'), /## Earlier records of this project \(0 folder\(s\), 0 file\(s\)\)\n\n- none/);
});

test('continues: is accepted in an order and shown next to the ID in the queue, in aos next and in the owner sheet', () => {
  assert.deepEqual(validateOrderText(order('ORD-0001', ['continues: OT-012 (stock import)']), 'ORD-0001.md', { pinned: true }), []);
  assert.match(validateOrderText(order('ORD-0001', ['continues: [a, b]']), 'ORD-0001.md', { pinned: true }).map((e) => e.code).join(), /E_FIELD_TYPE/);
  const root = adopted({ withLoop: true });
  place(root, 'ORD-0001', order('ORD-0001', ['continues: OT-012 (stock import)']));
  const queue = buildQueue(root, replay(readFileSync(logPath(root), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))).orders);
  assert.equal(queue[0].continues, 'OT-012 (stock import)');
  assert.match(queueText(queue, 'en'), /1\. ORD-0001 \(continues OT-012 \(stock import\)\) — /);
  assert.match(nextLine(root, { explicit: true, locale: 'en' }), /start ORD-0001 \(continues OT-012 \(stock import\)\) \(Title of ORD-0001\)/);
  const sheet = join(root, 'sheet.xlsx');
  assert.equal(aos(root, ['ceo', 'export', '--out', sheet]).status, 0);
  const cells = readWorkbook(readFileSync(sheet)).sheets.flatMap((s) => (s.cells instanceof Map ? [...s.cells.values()] : Object.values(s.cells))).map((c) => (c && typeof c === 'object' ? JSON.stringify(c) : String(c))).join('\n');
  assert.match(cells, /Title of ORD-0001 \(continues OT-012 \(stock import\)\)/);
  // An order without the key is shown as before.
  const other = adopted({ withLoop: true });
  place(other, 'ORD-0001', order('ORD-0001'));
  assert.match(nextLine(other, { explicit: true, locale: 'en' }), /start ORD-0001 \(Title of ORD-0001\)/);
});

test('aos docs check: a file added in a folder of earlier records must be named by its path in the order or an amendment', () => {
  const root = adopted({ withLoop: true });
  place(root, 'ORD-0001', order('ORD-0001', ['continues: OT-012']).replace('Work.', 'Work. It writes `docs/ordenes/OT-013-cierre.md`.'));
  commit(root, 'Director: ORD-0001 placed');
  // Named in the order: allowed. Changed (not added) files and files outside those folders do not count.
  write(root, 'docs/ordenes/OT-013-cierre.md');
  write(root, 'docs/ordenes/OT-012-tarea.md', 'changed\n');
  write(root, 'src/new.js');
  commit(root, 'work\n\nAnalucia-Order: ORD-0001');
  const ok = aos(root, ['docs', 'check', 'ORD-0001']);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout.trimEnd().split('\n').at(-1), /^OK: /);
  // One more document next to the old ones, named nowhere: refused, with the list.
  write(root, 'docs/ordenes/resumen-nuevo.md');
  write(root, 'informes/informe-2026-04.md');
  commit(root, 'more\n\nAnalucia-Order: ORD-0001');
  const bad = aos(root, ['docs', 'check', 'ORD-0001']);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /docs\/ordenes\/resumen-nuevo\.md/);
  assert.match(bad.stdout, /informes\/informe-2026-04\.md/);
  assert.doesNotMatch(bad.stdout, /OT-013-cierre|src\/new\.js/);
  assert.deepEqual(docsCheck(root, 'ORD-0001').unnamed, ['docs/ordenes/resumen-nuevo.md', 'informes/informe-2026-04.md']);
  // An amendment of the order that names them settles it.
  writeFileSync(join(root, '.analucia', 'amendments', 'AMD-0001.md'), ['---', 'id: AMD-0001', 'title: two more files', 'amends: ORD-0001', 'created: 2026-11-14', '---', '', 'Also `docs/ordenes/resumen-nuevo.md` and `informes/informe-2026-04.md`.', ''].join('\n'));
  assert.equal(aos(root, ['docs', 'check', 'ORD-0001']).status, 0);
  // A commit of another order is not judged here; an order with no commit passes.
  write(root, 'docs/ordenes/otro.md');
  commit(root, 'other\n\nAnalucia-Order: ORD-0002');
  assert.equal(aos(root, ['docs', 'check', 'ORD-0001']).status, 0);
  assert.equal(docsCheck(root, 'ORD-0002').unnamed.length, 1);
  assert.equal(aos(root, ['docs', 'check']).status, 2, 'usage');
});

test('aos docs check: with no folder of earlier records it exits 0 and says so in one line', () => {
  const root = mkdtempSync(join(tmpdir(), 'aos-earlier-plain-'));
  git(root, 'init', '-q', '-b', 'main');
  write(root, 'src/index.js');
  mkdirSync(join(root, '.analucia'), { recursive: true });
  writeFileSync(join(root, '.analucia', 'project.json'), '{"wip_limit":1,"locale":"en"}\n');
  writeFileSync(logPath(root), '');
  commit(root, 'x\n\nAnalucia-Order: ORD-0001');
  const r = aos(root, ['docs', 'check', 'ORD-0001']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trimEnd().split('\n').length, 1, r.stdout);
  assert.match(r.stdout, /^OK: this project has no folder of earlier records/);
});

test('the director entrypoint and the rules block say it in one sentence each', () => {
  const entry = readFileSync(fileURLToPath(new URL('../templates/director-entry.md', import.meta.url)), 'utf8');
  for (const text of [entry, blockTemplate()]) {
    const line = text.split('\n').find((l) => /continues:/.test(l) && /earlier record/.test(l));
    assert.ok(line, 'one sentence with the earlier record and continues:');
    assert.match(line, /existing document|\.analucia\//);
  }
});
