// SPEC-0004 §1–§2: asks as records, the owner sheet (export, reopen, import), zip and xlsx round trips.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildViews } from '../lib/derive.mjs';
import { hashLF } from '../lib/lock.mjs';
import { appendEvent, logPath, readLog } from '../lib/log.mjs';
import { askOpen, buildSheets, ceoExport, ceoImport, sheetData } from '../lib/owner-sheet.mjs';
import { replay } from '../lib/state.mjs';
import { validateFile, validateTree } from '../lib/validate.mjs';
import { readWorkbook, writeWorkbook } from '../lib/xlsx.mjs';
import { readZip, writeZip } from '../lib/zip.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env };
delete env.CLAUDE_PROJECT_DIR;
const aos = (root, args, input = '') => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input, env });
const log = (root) => readFileSync(logPath(root));
const CONFIRM = { isTTY: true, ask: async () => 'CONFIRM' };

const askText = (id, { kind = 'decide', options, body = 'Do we ship the owner sheet this week?' } = {}) => [
  '---', `id: ${id}`, `title: Question ${id}`, `kind: ${kind}`, 'created: 2026-10-21', 'recommendation: approve, the tests pass',
  ...(options ? [`options: [${options.join(', ')}]`] : []), '---', '', body, ''].join('\n');

// Orders ORD-0001 (verified), ORD-0002 (queued); asks ASK-0001 (decide), ASK-0002 (act, options done/not_done).
function sheetProject({ lockAsks = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aos-sheet-'));
  const a = join(root, '.analucia');
  for (const d of ['orders', 'asks', 'evidence']) mkdirSync(join(a, d), { recursive: true });
  writeFileSync(join(a, 'project.json'), '{"wip_limit":1}\n');
  writeFileSync(logPath(root), '');
  const files = {};
  for (const [id, title] of [['ORD-0001', 'Ship the sheet'], ['ORD-0002', 'Later work']]) {
    writeFileSync(join(a, 'orders', `${id}.md`), `---\nid: ${id}\ntitle: ${title}\nkind: build\ncreated: 2026-10-21\nbudget_max_minutes: 30\nbudget_max_attempts: 2\n---\n\n## Acceptance criteria\n\n- [ ] x\n`);
    files[`.analucia/orders/${id}.md`] = hashLF(readFileSync(join(a, 'orders', `${id}.md`)));
  }
  writeFileSync(join(a, 'asks', 'ASK-0001.md'), askText('ASK-0001'));
  writeFileSync(join(a, 'asks', 'ASK-0002.md'), askText('ASK-0002', { kind: 'act', options: ['done', 'not_done'], body: 'Rotate the key at the provider, please.' }));
  if (lockAsks) for (const id of ['ASK-0001', 'ASK-0002']) files[`.analucia/asks/${id}.md`] = hashLF(readFileSync(join(a, 'asks', `${id}.md`)));
  writeFileSync(join(a, 'director.lock'), `${JSON.stringify({ files }, null, 2)}\n`);
  const ev = (type, actor, subject, payload = {}) => appendEvent(root, { type, actor, subject, payload });
  for (const id of ['ORD-0001', 'ORD-0002']) {
    ev('record.created', 'director', id);
    ev('order.state_changed', 'director', id, { from: 'draft', to: 'ready' });
    ev('order.state_changed', 'director', id, { from: 'ready', to: 'queued' });
  }
  ev('order.state_changed', 'executor', 'ORD-0001', { from: 'queued', to: 'active' });
  ev('run.started', 'executor', 'ORD-0001', { run: 1 });
  ev('run.finished', 'executor', 'ORD-0001', { run: 1, outcome: 'done' });
  ev('order.state_changed', 'executor', 'ORD-0001', { from: 'active', to: 'delivered' });
  ev('order.state_changed', 'system', 'ORD-0001', { from: 'delivered', to: 'verified' });
  return root;
}
const openAsks = (root) => { askOpen(root, 'ASK-0001'); askOpen(root, 'ASK-0002'); };

// Fill the owner's cells of a freshly built sheet and write it (optionally the way Excel saves: shared strings).
function filledSheet(root, fills, { sharedStrings = false } = {}) {
  const sheets = buildSheets(sheetData(root), 'es');
  for (const [sheetIndex, at, value] of fills) {
    const col = at.charCodeAt(0) - 65;
    const row = Number(at.slice(1)) - 1;
    sheets[sheetIndex].rows[row][col] = { v: value, style: 'input' };
  }
  const path = join(root, 'filled.xlsx');
  writeFileSync(path, writeWorkbook(sheets, { sharedStrings }));
  return path;
}

test('zip: writer and reader round-trip, CRC is checked', () => {
  const files = [{ name: 'a.txt', data: 'hello' }, { name: 'dir/b.xml', data: '<x>ünïcode</x>'.repeat(50) }];
  const z = writeZip(files);
  assert.equal(z.readUInt32LE(0), 0x04034b50);
  const back = readZip(z);
  assert.equal(back.get('a.txt').toString(), 'hello');
  assert.equal(back.get('dir/b.xml').toString(), files[1].data);
  assert.deepEqual(writeZip(files), z, 'deterministic bytes');
  const bad = Buffer.from(z);
  bad[40] ^= 0xff; // inside the first compressed entry
  assert.throws(() => readZip(bad));
});

test('asks: the validator accepts a valid ask and rejects bad ones', () => {
  const root = sheetProject();
  assert.deepEqual(validateTree(root), []);
  const p = join(root, '.analucia', 'asks', 'ASK-0001.md');
  const codes = () => validateFile(p).map((e) => e.code);
  writeFileSync(p, askText('ASK-0001', { body: 'x'.repeat(601) }));
  assert.deepEqual(codes(), ['E_ASK_TOO_LONG']);
  writeFileSync(p, askText('ASK-0001', { kind: 'act' }));
  assert.deepEqual(codes(), ['E_MISSING_FIELD'], 'non-decide asks need options');
  writeFileSync(p, askText('ASK-0001', { kind: 'pay' }));
  assert.deepEqual(codes(), ['E_ASK_KIND_ENUM']);
  writeFileSync(p, askText('ASK-0001').replace('kind: decide', 'kind: decide\nstate: open'));
  assert.deepEqual(codes(), ['E_STATE_IN_DEFINITION']);
  writeFileSync(p, askText('ASK-0001', { body: '' }));
  assert.deepEqual(codes(), ['E_MISSING_FIELD']);
});

test('aos ask open: needs the lock, records record.created + ask.opened (director), refuses twice', () => {
  const unlocked = sheetProject({ lockAsks: false });
  const before = log(unlocked);
  const r = aos(unlocked, ['ask', 'open', 'ASK-0001']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /E_NOT_LOCKED/);
  assert.deepEqual(log(unlocked), before);

  const root = sheetProject();
  const ok = aos(root, ['ask', 'open', 'ASK-0001']);
  assert.equal(ok.status, 0, ok.stderr);
  const [created, opened] = readLog(root).events.slice(-2);
  assert.deepEqual([created.type, created.actor, opened.type, opened.actor], ['record.created', 'director', 'ask.opened', 'director']);
  assert.deepEqual(opened.payload.options, ['approve', 'reject', 'change']);
  assert.match(aos(root, ['ask', 'open', 'ASK-0001']).stderr, /E_RECORD_EXISTS/);
  assert.match(aos(root, ['ask', 'open', 'ASK-0009']).stderr, /E_FILE_MISSING/);
  assert.deepEqual(validateTree(root), []);
});

test('only the owner resolves an ask, once, with one of its options', () => {
  const root = sheetProject();
  openAsks(root);
  const res = (actor, decision) => () => appendEvent(root, { type: 'ask.resolved', actor, subject: 'ASK-0002', payload: { decision, comment: '', via: 'sheet' } });
  assert.throws(res('director', 'done'), (x) => x.code === 'E_TRANSITION');
  assert.throws(res('owner', 'approve'), (x) => x.code === 'E_TRANSITION', 'not an option of ASK-0002');
  res('owner', 'done')();
  assert.throws(res('owner', 'done'), (x) => x.code === 'E_TRANSITION', 'already resolved');
});

test('export -> reopen with the reader -> same cells (inline and shared strings), with inputs, lists and frozen header', () => {
  const root = sheetProject();
  openAsks(root);
  const r = aos(root, ['ceo', 'export', '--out', '.analucia/views/owner-sheet.xlsx', '--locale', 'es']);
  assert.equal(r.status, 0, r.stderr);
  const buf = readFileSync(join(root, '.analucia', 'views', 'owner-sheet.xlsx'));
  assert.deepEqual([buf[0], buf[1]], [0x50, 0x4b], 'a zip file');
  const expected = buildSheets(sheetData(root), 'es');
  for (const wbBuf of [buf, writeWorkbook(expected, { sharedStrings: true })]) {
    const wb = readWorkbook(wbBuf);
    assert.deepEqual(wb.sheets.map((s) => s.name), ['Cómo usar', 'Preguntas', 'Órdenes', 'Estados']);
    expected.forEach((sheet, i) => {
      const want = new Map();
      sheet.rows.forEach((row, ri) => row.forEach((c, ci) => {
        const v = c && typeof c === 'object' ? c.v : c;
        if (v !== null && v !== undefined && v !== '') want.set(`${String.fromCharCode(65 + ci)}${ri + 1}`, String(v));
      }));
      assert.deepEqual(new Map([...wb.sheets[i].cells].sort()), new Map([...want].sort()), sheet.name);
    });
  }
  const wb = readWorkbook(buf);
  assert.equal(wb.value('Preguntas', 'A2'), 'ASK-0001');
  assert.equal(wb.value('Preguntas', 'C2'), 'Do we ship the owner sheet this week?');
  assert.equal(wb.value('Preguntas', 'E2'), 'open');
  assert.equal(wb.value('Órdenes', 'D2'), 'verified');
  assert.equal(wb.value('Órdenes', 'E2'), 'owner');
  assert.equal(wb.value('Órdenes', 'E3'), 'executor');
  assert.equal(wb.value('Estados', 'A2'), 'draft', 'values stay English');
  const zip = readZip(buf);
  const asks = zip.get('xl/worksheets/sheet2.xml').toString();
  const orders = zip.get('xl/worksheets/sheet3.xml').toString();
  assert.match(asks, /<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/);
  assert.match(asks, /<autoFilter ref="A1:G3"\/>/);
  assert.match(asks, /<dataValidation type="list"[^>]*sqref="F2"><formula1>"approve,reject,change"<\/formula1>/);
  assert.match(asks, /<dataValidation type="list"[^>]*sqref="F3"><formula1>"done,not_done"<\/formula1>/);
  assert.match(asks, /<c r="F2" s="3"\/>/, 'the decision cell of an open ask is a yellow input');
  assert.match(orders, /sqref="H2"><formula1>"close,hold"<\/formula1>/);
  assert.match(orders, /<c r="H2" s="3"\/>/);
  assert.doesNotMatch(orders, /r="H3"/, 'no sign-off cell on a non-verified order');
  assert.match(zip.get('xl/styles.xml').toString(), /FFFFF2A8[\s\S]*<protection locked="0"\/>/);
  const en = aos(root, ['ceo', 'export', '--out', 'en.xlsx', '--locale', 'en']);
  assert.equal(en.status, 0);
  assert.equal(readWorkbook(readFileSync(join(root, 'en.xlsx'))).sheets[1].name, 'Asks');
});

test('a workbook saved with a shared-strings table (as Excel does) imports correctly', async () => {
  const root = sheetProject();
  openAsks(root);
  const path = filledSheet(root, [[1, 'F2', 'approve'], [1, 'G2', 'go ahead'], [1, 'F3', 'done'], [2, 'H2', 'close'], [2, 'I2', 'good work']], { sharedStrings: true });
  const zip = readZip(readFileSync(path));
  assert.ok(zip.has('xl/sharedStrings.xml'));
  assert.match(zip.get('xl/worksheets/sheet2.xml').toString(), /<c r="F2" s="3" t="s"><v>\d+<\/v><\/c>/);
  const plan = await ceoImport(root, path, CONFIRM);
  assert.equal(plan.length, 3);
  const s = replay(readLog(root).events);
  assert.deepEqual([s.asks['ASK-0001'].status, s.asks['ASK-0001'].decision, s.asks['ASK-0001'].comment], ['resolved', 'approve', 'go ahead']);
  assert.equal(s.asks['ASK-0002'].decision, 'done');
  assert.equal(s.orders['ORD-0001'].state, 'closed');
  const closeEvent = readLog(root).events.at(-1);
  assert.deepEqual([closeEvent.actor, closeEvent.payload.via, closeEvent.payload.comment], ['owner', 'sheet', 'good work']);
  const resolved = readLog(root).events.find((e) => e.type === 'ask.resolved');
  assert.deepEqual(resolved.payload, { decision: 'approve', comment: 'go ahead', via: 'sheet' });
  assert.deepEqual(validateTree(root), []);
});

test('import without a TTY is refused (E_OWNER_TTY) and records nothing', () => {
  const root = sheetProject();
  openAsks(root);
  const path = filledSheet(root, [[1, 'F2', 'approve']]);
  const before = log(root);
  const r = aos(root, ['ceo', 'import', path], 'CONFIRM\n');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /aos ceo import: E_OWNER_TTY /);
  assert.deepEqual(log(root), before);
});

test('an invalid option is E_SHEET_VALUE and nothing is recorded (all-or-nothing)', async () => {
  const root = sheetProject();
  openAsks(root);
  const path = filledSheet(root, [[1, 'F2', 'approve'], [1, 'F3', 'maybe']]);
  const before = log(root);
  await assert.rejects(ceoImport(root, path, CONFIRM), (x) => x.code === 'E_SHEET_VALUE' && x.problems.length === 1 && /Preguntas!F3: "maybe" is not an option of ASK-0002 \(done, not_done\)/.test(x.problems[0]));
  assert.deepEqual(log(root), before, 'the valid ASK-0001 decision was not recorded either');
  await assert.rejects(ceoImport(root, filledSheet(root, [[2, 'H2', 'sign']]), CONFIRM), (x) => x.code === 'E_SHEET_VALUE');
  await assert.rejects(ceoImport(root, filledSheet(root, [[1, 'G2', 'a comment only']]), CONFIRM), (x) => x.code === 'E_SHEET_VALUE');
  await assert.rejects(ceoImport(root, filledSheet(root, [[1, 'F2', 'approve']]), { isTTY: true, ask: async () => 'yes' }), (x) => x.code === 'E_NOT_CONFIRMED');
  assert.deepEqual(log(root), before);
});

test('a close on a non-verified order is refused', async () => {
  const root = sheetProject();
  openAsks(root);
  const sheets = buildSheets(sheetData(root), 'en');
  sheets[2].rows[2][7] = { v: 'close', style: 'input' }; // ORD-0002 (queued): the owner typed into a locked cell anyway
  const path = join(root, 'tampered.xlsx');
  writeFileSync(path, writeWorkbook(sheets));
  const before = log(root);
  await assert.rejects(ceoImport(root, path, CONFIRM), (x) => x.code === 'E_SHEET_VALUE' && /Orders!H3: ORD-0002 is "queued"; only verified orders can be closed/.test(x.problems[0]));
  assert.deepEqual(log(root), before);
});

test('a resolved ask disappears from the open list (resume and sheet)', async () => {
  const root = sheetProject();
  openAsks(root);
  const pending = () => buildViews(root).resume.split('\n').filter((l) => /^- .* ASK-\d{4} ask/.test(l));
  assert.equal(pending().length, 2);
  await ceoImport(root, filledSheet(root, [[1, 'F2', 'reject'], [1, 'G2', 'not now']]), CONFIRM);
  assert.deepEqual(pending().map((l) => /ASK-\d{4}/.exec(l)[0]), ['ASK-0002']);
  const wb = readWorkbook(readFileSync(join(root, ceoExport(root, { out: 'again.xlsx' }).path)));
  assert.deepEqual([wb.value('Asks', 'E2'), wb.value('Asks', 'F2'), wb.value('Asks', 'G2')], ['resolved', 'reject', 'not now']);
  const xml = readZip(readFileSync(join(root, 'again.xlsx'))).get('xl/worksheets/sheet2.xml').toString();
  assert.doesNotMatch(xml, /sqref="F2"/, 'no drop-down on a resolved ask');
  assert.match(xml, /sqref="F3"/);
  // Re-importing a sheet that shows the recorded decision records nothing new.
  assert.deepEqual(await ceoImport(root, join(root, 'again.xlsx'), CONFIRM), []);
});
