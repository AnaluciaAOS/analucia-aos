// ORD-0043 part 9 (OBS-143): copies of data are cleaned. `aos scratch add` records each folder with a copy of real
// data and each process that serves it; `aos scratch check` passes only when all are gone; `aos run finish --outcome
// done` refuses while one remains. With scratch folders and a scratch process started by the test.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { blockTemplate } from '../lib/guards.mjs';
import { appendEvent, logPath, readLog } from '../lib/log.mjs';
import { processAlive, scratchRel } from '../lib/scratch.mjs';
import { replay } from '../lib/state.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env };
delete env.CLAUDE_PROJECT_DIR;
delete env.CLAUDE_CODE_SESSION_ID;
const aos = (root, args) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input: '', env });
const REPORT = '.analucia/evidence/ORD-0001/report.md';

// One order with a run open and a report that says the work is complete.
function running() {
  const root = mkdtempSync(join(tmpdir(), 'aos-scratch-'));
  const a = join(root, '.analucia');
  for (const d of ['orders', 'evidence/ORD-0001']) mkdirSync(join(a, d), { recursive: true });
  writeFileSync(join(a, 'project.json'), '{"wip_limit":1,"locale":"en"}\n');
  writeFileSync(logPath(root), '');
  writeFileSync(join(a, 'orders', 'ORD-0001.md'), ['---', 'id: ORD-0001', 'title: T', 'kind: fix', 'created: 2026-11-16', 'budget_max_minutes: 30', 'budget_max_attempts: 3', '---', '', '## Acceptance criteria', '', '- [ ] x', ''].join('\n'));
  appendEvent(root, { type: 'record.created', actor: 'director', subject: 'ORD-0001' });
  appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: 'ORD-0001', payload: { from: 'draft', to: 'ready' } });
  appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: 'ORD-0001', payload: { from: 'ready', to: 'queued' } });
  assert.equal(aos(root, ['run', 'start', 'ORD-0001']).status, 0);
  writeFileSync(join(root, REPORT), ['# r', '', '## Evidencia', '', 'x', '', 'Work: complete', 'OUTCOME: done', ''].join('\n'));
  return root;
}
const finish = (root, outcome) => aos(root, ['run', 'finish', 'ORD-0001', '--outcome', outcome, '--evidence', REPORT]);
const state = (root) => replay(readLog(root).events).orders['ORD-0001'].state;
// A scratch process that only waits; killed by the test.
const sleeper = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
const ended = (child) => new Promise((done) => { child.once('exit', done); child.kill(); });

test('with nothing recorded, aos scratch check exits 0 with one line', () => {
  const root = running();
  const r = aos(root, ['scratch', 'check', 'ORD-0001']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trimEnd().split('\n').length, 1);
  assert.match(r.stdout, /no copy of data recorded for ORD-0001/);
});

test('aos scratch add records the folder and the process, names and numbers only; check lists what remains and passes when all is gone', async () => {
  const root = running();
  const copy = mkdtempSync(join(tmpdir(), 'aos-copy-'));
  writeFileSync(join(copy, 'data.txt'), 'CONTENT-THAT-MUST-NOT-BE-RECORDED\n');
  const child = sleeper();
  try {
    const add = aos(root, ['scratch', 'add', 'ORD-0001', '--path', copy, '--pid', String(child.pid)]);
    assert.equal(add.status, 0, add.stderr);
    const file = readFileSync(join(root, scratchRel('ORD-0001')), 'utf8');
    const data = JSON.parse(file);
    assert.equal(data.order, 'ORD-0001');
    assert.equal(data.copies.length, 1);
    assert.deepEqual(Object.keys(data.copies[0]).sort(), ['added', 'path', 'pid']);
    assert.equal(data.copies[0].pid, child.pid);
    assert.doesNotMatch(file, /CONTENT-THAT-MUST-NOT-BE-RECORDED|data\.txt/);
    // The same copy twice is one record.
    assert.equal(aos(root, ['scratch', 'add', 'ORD-0001', '--path', copy, '--pid', String(child.pid)]).status, 0);
    assert.equal(JSON.parse(readFileSync(join(root, scratchRel('ORD-0001')), 'utf8')).copies.length, 1);

    const both = aos(root, ['scratch', 'check', 'ORD-0001']);
    assert.equal(both.status, 1);
    assert.match(both.stdout, /folder still there: /);
    assert.match(both.stdout, new RegExp(`process still running: ${child.pid}\\b`));

    rmSync(copy, { recursive: true, force: true });
    const onlyProcess = aos(root, ['scratch', 'check', 'ORD-0001']);
    assert.equal(onlyProcess.status, 1);
    assert.doesNotMatch(onlyProcess.stdout, /folder still there/);
    assert.match(onlyProcess.stdout, /process still running/);
  } finally {
    await ended(child);
  }
  assert.equal(processAlive(child.pid), false);
  const clean = aos(root, ['scratch', 'check', 'ORD-0001']);
  assert.equal(clean.status, 0, clean.stdout);
  assert.match(clean.stdout, /1 recorded copy of data of ORD-0001: every folder is gone and every process has ended/);
});

test('aos run finish --outcome done refuses while a recorded copy remains, with the list and the command; other outcomes are not held', () => {
  const root = running();
  const copy = mkdtempSync(join(tmpdir(), 'aos-copy-'));
  assert.equal(aos(root, ['scratch', 'add', 'ORD-0001', '--path', copy]).status, 0);
  const lines = readLog(root).events.length;
  const r = finish(root, 'done');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /aos run finish: E_SCRATCH_REMAINS /);
  assert.match(r.stderr, /folder still there: /);
  assert.match(r.stderr, /scratch check ORD-0001/);
  assert.equal(state(root), 'active', 'the run stays open');
  assert.equal(readLog(root).events.length, lines, 'nothing was recorded');
  // Once the copy is deleted the same command delivers.
  rmSync(copy, { recursive: true, force: true });
  const ok = finish(root, 'done');
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(state(root), 'delivered');

  // budget_exhausted is not held: the copy may still be needed by the next run.
  const other = running();
  const kept = mkdtempSync(join(tmpdir(), 'aos-copy-'));
  assert.equal(aos(other, ['scratch', 'add', 'ORD-0001', '--path', kept]).status, 0);
  writeFileSync(join(other, REPORT), ['# r', '', '## Evidencia', '', 'x', '', 'Work: not complete', 'OUTCOME: budget_exhausted', ''].join('\n'));
  assert.equal(finish(other, 'budget_exhausted').status, 0);
  assert.equal(state(other), 'queued');
  rmSync(kept, { recursive: true, force: true });
});

test('aos scratch add refuses an order that does not exist, a missing path and a pid that is not a number; a broken record is an error, not "nothing recorded"', () => {
  const root = running();
  assert.match(aos(root, ['scratch', 'add', 'ORD-0009', '--path', tmpdir()]).stderr, /E_NO_ORDER/);
  assert.equal(aos(root, ['scratch', 'add', 'ORD-0001']).status, 2);
  assert.match(aos(root, ['scratch', 'add', 'ORD-0001', '--path', tmpdir(), '--pid', 'abc']).stderr, /E_FIELD_TYPE/);
  assert.equal(existsSync(join(root, scratchRel('ORD-0001'))), false);
  writeFileSync(join(root, scratchRel('ORD-0001')), 'not json\n');
  const r = aos(root, ['scratch', 'check', 'ORD-0001']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /E_JSON/);
});

test('the director entrypoint says which backups stay, and the rules block says it in one line for the executor', () => {
  const entry = readFileSync(fileURLToPath(new URL('../templates/director-entry.md', import.meta.url)), 'utf8');
  const line = entry.split('\n').find((l) => /copies real data/.test(l));
  assert.ok(line, 'one sentence in the director entrypoint');
  assert.match(line, /backups that are kept/);
  assert.match(line, /nothing else is deleted/);
  assert.match(line, /aos scratch check/);
  // AMD-0019: the sentence moved to RULES-DETAIL.md; the block keeps one pointer line for it.
  const pointer = blockTemplate().split('\n').find((l) => /RULES-DETAIL "Copies of real data"/.test(l));
  assert.ok(pointer, 'one pointer line in the rules block');
  assert.match(pointer, /delete only what the order names/);
  const detail = readFileSync(fileURLToPath(new URL('../docs/RULES-DETAIL.md', import.meta.url)), 'utf8');
  const rule = detail.split('\n').find((l) => /aos scratch add/.test(l));
  assert.ok(rule, 'the sentence is in the document');
  assert.match(rule, /aos scratch check/);
  assert.match(rule, /only what the order names/);
});
