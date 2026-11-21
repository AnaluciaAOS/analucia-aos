// ORD-0043 part 13 (OBS-169): the report lines come from the verify file. A verify file may carry `report_lines`, a
// list of { name, pattern }; `aos verify` checks each one against the report of the order as a check of class form;
// `aos report template <ID>` prints the skeleton with one line per entry; `aos report check <ID>` tries only those
// lines and the fixed sections on the report as it is and changes no state; `aos run finish --outcome done` runs that
// check itself and refuses while a line is missing (E_REPORT_LINES): the run stays open, no attempt is consumed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { blockTemplate } from '../lib/guards.mjs';
import { hashLF } from '../lib/lock.mjs';
import { appendEvent, logPath, readLog } from '../lib/log.mjs';
import { missingLines, reportCheck, reportTemplate } from '../lib/report.mjs';
import { replay } from '../lib/state.mjs';
import { validateVerifyText } from '../lib/validate.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env };
delete env.CLAUDE_PROJECT_DIR;
delete env.CLAUDE_CODE_SESSION_ID;
const aos = (root, args) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input: '', env });
const REPORT = '.analucia/evidence/ORD-0001/report.md';
const LINES = [
  { name: 'the public main', pattern: '^Public main: [0-9a-f]{40}$' },
  { name: 'values printed', pattern: '^Values printed: none$' },
];
const verifyFile = (extra = {}) => `${JSON.stringify({ order: 'ORD-0001', checks: [{ name: 'the check', run: 'exit 0', expect_exit: 0 }], ...extra }, null, 2)}\n`;
const report = (lines = []) => ['# ORD-0001 — report of run 1', '', ...lines, '', '## Evidencia', '', 'x', '', 'Work: complete', 'OUTCOME: done', ''].join('\n');
const GOOD = [`Public main: ${'a'.repeat(40)}`, 'Values printed: none'];

// One order, placed and locked, with a run open; its verify file and its report as given.
function running({ verify = verifyFile({ report_lines: LINES }), text = report(GOOD), risk = 'low' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aos-lines-'));
  const a = join(root, '.analucia');
  for (const d of ['orders', 'verify', 'evidence/ORD-0001']) mkdirSync(join(a, d), { recursive: true });
  writeFileSync(join(a, 'project.json'), '{"wip_limit":1,"locale":"en"}\n');
  writeFileSync(logPath(root), '');
  writeFileSync(join(a, 'orders', 'ORD-0001.md'), ['---', 'id: ORD-0001', 'title: T', 'kind: fix', 'created: 2026-11-16', 'budget_max_minutes: 30', 'budget_max_attempts: 3', `risk: ${risk}`, 'cost_effect: none', '---', '', '## Acceptance criteria', '', '- [ ] x', ''].join('\n'));
  if (verify) writeFileSync(join(a, 'verify', 'ORD-0001.json'), verify);
  const files = {};
  for (const rel of ['.analucia/orders/ORD-0001.md', ...(verify ? ['.analucia/verify/ORD-0001.json'] : [])]) files[rel] = hashLF(readFileSync(join(root, rel)));
  writeFileSync(join(a, 'director.lock'), JSON.stringify({ files }));
  appendEvent(root, { type: 'record.created', actor: 'director', subject: 'ORD-0001' });
  appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: 'ORD-0001', payload: { from: 'draft', to: 'ready' } });
  appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: 'ORD-0001', payload: { from: 'ready', to: 'queued' } });
  const start = aos(root, ['run', 'start', 'ORD-0001']);
  assert.equal(start.status, 0, start.stderr);
  if (text !== null) writeFileSync(join(root, REPORT), text);
  return root;
}
const finish = (root, outcome) => aos(root, ['run', 'finish', 'ORD-0001', '--outcome', outcome, '--evidence', REPORT]);
const state = (root) => replay(readLog(root).events).orders['ORD-0001'].state;

test('a verify file may carry report_lines: a list of { name, pattern }, each pattern a regular expression of one line', () => {
  const codes = (report_lines) => validateVerifyText(verifyFile({ report_lines }), 'ORD-0001.json').map((e) => e.code);
  assert.deepEqual(codes(LINES), []);
  assert.deepEqual(validateVerifyText(verifyFile(), 'ORD-0001.json'), [], 'without the key the file is valid as before');
  assert.deepEqual(codes('x'), ['E_FIELD_TYPE']);
  assert.deepEqual(codes([]), ['E_FIELD_TYPE']);
  assert.deepEqual(codes([{ name: 'no pattern' }]), ['E_MISSING_FIELD']);
  assert.deepEqual(codes([{ name: 'x', pattern: '^a$', run: 'exit 0' }]), ['E_UNKNOWN_KEY']);
  assert.deepEqual(codes([{ name: 'x', pattern: '(' }]), ['E_FIELD_TYPE'], 'not a regular expression');
  assert.deepEqual(codes([{ name: 'x', pattern: 'a\nb' }]), ['E_FIELD_TYPE'], 'one line only');
  assert.deepEqual(codes([{ name: '', pattern: '^a$' }]), ['E_FIELD_TYPE']);
});

test('aos report template prints the skeleton with the fixed sections and one line per entry; aos report check says what is missing and changes no state', () => {
  const root = running({ text: report(['Values printed: none']) });
  const tpl = aos(root, ['report', 'template', 'ORD-0001']);
  assert.equal(tpl.status, 0, tpl.stderr);
  assert.equal(tpl.stdout, reportTemplate(root, 'ORD-0001'));
  assert.match(tpl.stdout, /^# ORD-0001 — report of run N$/m);
  for (const fixed of ['## Para el dueño', '## Evidencia', 'Work: <complete | not complete>', 'OUTCOME: <']) assert.ok(tpl.stdout.includes(fixed), fixed);
  for (const l of LINES) assert.ok(tpl.stdout.includes(`<${l.name}: a line that matches ${l.pattern}>`), l.name);
  assert.ok(tpl.stdout.indexOf('## Lines this report must carry') < tpl.stdout.indexOf('## Evidencia'));

  const before = readFileSync(logPath(root), 'utf8');
  const bad = aos(root, ['report', 'check', 'ORD-0001']);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /missing line: the public main \(a line that matches \^Public main: \[0-9a-f\]\{40\}\$\)/);
  assert.doesNotMatch(bad.stdout, /missing line: values printed/);
  assert.match(bad.stdout, /1 of 2 line\(s\) missing/);
  // A line that is almost right is missing: the pattern is of the whole line.
  assert.deepEqual(missingLines('Public main: abc\n  Values printed: none\n', LINES).map((l) => l.name), ['the public main', 'values printed']);
  assert.deepEqual(missingLines(`Public main: ${'0'.repeat(40)}\r\nValues printed: none\r\n`, LINES), [], 'a CRLF checkout is the same report');

  writeFileSync(join(root, REPORT), report(GOOD));
  const ok = aos(root, ['report', 'check', 'ORD-0001']);
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /the 2 line\(s\) of the verify file and the fixed sections are there/);
  // A fixed section missing is said too.
  writeFileSync(join(root, REPORT), `${GOOD.join('\n')}\nOUTCOME: done\n`);
  const noSection = aos(root, ['report', 'check', 'ORD-0001']);
  assert.equal(noSection.status, 1);
  assert.match(noSection.stdout, /missing: the section "## Evidencia"/);
  assert.match(noSection.stdout, /missing: the line "Work: complete" or "Work: not complete"/);
  assert.equal(readFileSync(logPath(root), 'utf8'), before, 'no state is changed and nothing is recorded');
  // No report yet, and usage.
  const none = running({ text: null });
  const r = aos(none, ['report', 'check', 'ORD-0001']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /there is no report at \.analucia\/evidence\/ORD-0001\/report\.md/);
  assert.equal(aos(none, ['report', 'check']).status, 2);
  assert.equal(aos(none, ['report', 'print', 'ORD-0001']).status, 2);
});

test('an order without report_lines, or without a verify file: only the fixed sections are tried', () => {
  const root = running({ verify: verifyFile() });
  const ok = aos(root, ['report', 'check', 'ORD-0001']);
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /the verify file names no line/);
  assert.deepEqual(reportCheck(root, 'ORD-0001').entries, []);
  assert.doesNotMatch(aos(root, ['report', 'template', 'ORD-0001']).stdout, /Lines this report must carry/);
  assert.equal(finish(root, 'done').status, 0);
  const bare = running({ verify: null });
  assert.equal(aos(bare, ['report', 'check', 'ORD-0001']).status, 0);
  assert.equal(finish(bare, 'done').status, 0);
});

test('aos run finish --outcome done refuses while a line is missing: the run stays open, no attempt is consumed; any other outcome is not held', () => {
  const root = running({ text: report(['Values printed: none']) });
  const before = readFileSync(logPath(root), 'utf8');
  const r = finish(root, 'done');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /E_REPORT_LINES/);
  assert.match(r.stderr, /the public main \(a line that matches/);
  assert.match(r.stderr, /next \(executor\)/);
  assert.equal(readFileSync(logPath(root), 'utf8'), before, 'nothing was recorded');
  assert.equal(state(root), 'active');
  // The line is put back: the same run is finished.
  writeFileSync(join(root, REPORT), report(GOOD));
  const ok = finish(root, 'done');
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(state(root), 'delivered');
  assert.equal(readLog(root).events.filter((e) => e.type === 'run.started').length, 1);
  // Another outcome is not held by a missing line.
  for (const outcome of ['budget_exhausted', 'failed', 'blocked']) {
    const other = running({ text: report([]).replace('Work: complete', 'Work: not complete') });
    assert.equal(finish(other, outcome).status, 0, outcome);
  }
});

test('aos verify checks each line against the report as a check of class form', () => {
  const root = running({ text: report(['Values printed: none']) });
  // Delivered with the line missing (as an older tool would have let it): verify fails on a check of form only.
  appendEvent(root, { type: 'run.finished', actor: 'executor', subject: 'ORD-0001', payload: { run: 1, outcome: 'done' } });
  appendEvent(root, { type: 'order.state_changed', actor: 'executor', subject: 'ORD-0001', payload: { from: 'active', to: 'delivered' } });
  const bad = aos(root, ['verify', 'ORD-0001']);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /^FAIL \[form\] report line: the public main/m);
  assert.match(bad.stdout, /^PASS report line: values printed/m);
  assert.match(bad.stderr, /substance: 0, form: 1/);
  const attached = readLog(root).events.filter((e) => e.type === 'evidence.attached' && e.payload.level === 'verified').at(-1);
  assert.deepEqual(attached.payload.checks.map((c) => [c.name, c.passed, c.class ?? 'substance']), [['the check', true, 'substance'], ['report line: the public main', false, 'form'], ['report line: values printed', true, 'form']]);
  const evidence = readFileSync(join(root, attached.payload.path), 'utf8');
  assert.match(evidence, /report line 1: the public main/);
  assert.match(evidence, /failed checks of form \(1\): report line: the public main/);
  // With the line there, the order is verified.
  writeFileSync(join(root, REPORT), report(GOOD));
  const ok = aos(root, ['verify', 'ORD-0001']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(state(root), 'verified');
});

test('the director entrypoint and the rules block say it', () => {
  const entry = readFileSync(fileURLToPath(new URL('../templates/director-entry.md', import.meta.url)), 'utf8');
  assert.match(entry, /`report_lines`, not in hand-written `grep` checks/);
  assert.match(blockTemplate(), /`aos report check ORD-NNNN`/);
});
