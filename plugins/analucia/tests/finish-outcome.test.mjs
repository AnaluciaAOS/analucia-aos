// ORD-0043 part 4 (OBS-166): the right closing outcome. The report says in one fixed line whether the work is
// complete (`Work: complete` | `Work: not complete`). `aos run finish` refuses `blocked` and `needs_decision` when
// the report says the work is complete: a blocked order is not offered for signature, so finished work would have
// no way to the owner. A report without the line is accepted as before, with one line of warning. `aos sign`
// explains the way out of a blocked order, and offers nothing to close for it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { blockTemplate } from '../lib/guards.mjs';
import { appendEvent, logPath, readLog } from '../lib/log.mjs';
import { workLine } from '../lib/lifecycle.mjs';
import { sign } from '../lib/sign.mjs';
import { replay } from '../lib/state.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const baseEnv = { ...process.env };
delete baseEnv.CLAUDE_PROJECT_DIR;
delete baseEnv.CLAUDE_CODE_SESSION_ID;
const aos = (root, args) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input: '', env: baseEnv });
const REPORT = '.analucia/evidence/report.md';
const report = (work, outcome) => ['# r', '', '## Evidencia', '', 'x', '', ...(work ? [`Work: ${work}`] : []), `OUTCOME: ${outcome}`, ''].join('\n');

// One order with a run open, and the report as given.
function running(text) {
  const root = mkdtempSync(join(tmpdir(), 'aos-outcome-'));
  const a = join(root, '.analucia');
  for (const d of ['orders', 'evidence']) mkdirSync(join(a, d), { recursive: true });
  writeFileSync(join(a, 'project.json'), '{"wip_limit":1,"locale":"en"}\n');
  writeFileSync(logPath(root), '');
  writeFileSync(join(a, 'orders', 'ORD-0001.md'), ['---', 'id: ORD-0001', 'title: T', 'kind: fix', 'created: 2026-11-16', 'budget_max_minutes: 30', 'budget_max_attempts: 3', '---', '', '## Acceptance criteria', '', '- [ ] x', ''].join('\n'));
  appendEvent(root, { type: 'record.created', actor: 'director', subject: 'ORD-0001' });
  appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: 'ORD-0001', payload: { from: 'draft', to: 'ready' } });
  appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: 'ORD-0001', payload: { from: 'ready', to: 'queued' } });
  assert.equal(aos(root, ['run', 'start', 'ORD-0001']).status, 0);
  writeFileSync(join(root, REPORT), text);
  return root;
}
const finish = (root, outcome, extra = []) => aos(root, ['run', 'finish', 'ORD-0001', '--outcome', outcome, '--evidence', REPORT, ...extra]);
const state = (root) => replay(readLog(root).events).orders['ORD-0001'].state;

test('the fixed line of the report: read exactly, and present in the template just above the outcome', () => {
  assert.equal(workLine(report('complete', 'done')), 'complete');
  assert.equal(workLine(report('not complete', 'blocked')), 'not complete');
  assert.equal(workLine(report(null, 'done')), null);
  assert.equal(workLine('Work: complete\r\nOUTCOME: done\r\n'), 'complete', 'a CRLF checkout is the same report');
  for (const text of ['Work: completed\n', 'work: complete\n', '  Work: complete\n', 'Work: done\n', 'The Work: complete\n']) assert.equal(workLine(text), null, text);
  const template = readFileSync(fileURLToPath(new URL('../templates/report.md', import.meta.url)), 'utf8').replace(/\r\n/g, '\n').trimEnd().split('\n');
  assert.match(template.at(-1), /^OUTCOME: /);
  assert.match(template.at(-2), /^Work: /);
});

test('aos run finish refuses blocked and needs_decision when the report says the work is complete; the run stays open', () => {
  for (const outcome of ['blocked', 'needs_decision']) {
    const root = running(report('complete', outcome));
    const before = readFileSync(logPath(root), 'utf8');
    const r = finish(root, outcome, ['--reason', 'the owner must review the document']);
    assert.equal(r.status, 1, outcome);
    assert.match(r.stderr, /aos run finish: E_WORK_COMPLETE /);
    assert.match(r.stderr, /--outcome done/);
    assert.match(r.stderr, /review request/);
    assert.match(r.stderr, /next \(executor\)/);
    assert.equal(readFileSync(logPath(root), 'utf8'), before, 'nothing was written');
    assert.equal(state(root), 'active');
    // The same report finishes as done.
    assert.equal(finish(root, 'done').status, 0);
    assert.equal(state(root), 'delivered');
  }
});

test('work that is not complete finishes blocked as before; the other outcomes are never held by the line', () => {
  const root = running(report('not complete', 'blocked'));
  const r = finish(root, 'blocked', ['--reason', 'no access to the server']);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /warning: .*Work:/);
  assert.equal(state(root), 'blocked');
  for (const outcome of ['budget_exhausted', 'failed', 'done']) {
    const other = running(report('complete', outcome));
    assert.equal(finish(other, outcome).status, 0, outcome);
  }
});

test('a report without the line is accepted as before, with one line of warning', () => {
  const root = running(report(null, 'blocked'));
  const r = finish(root, 'blocked', ['--reason', 'no access to the server']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(state(root), 'blocked');
  const warnings = r.stdout.split('\n').filter((l) => /^warning: /.test(l) && /Work: complete/.test(l));
  assert.equal(warnings.length, 1, r.stdout);
  assert.match(warnings[0], /Work: not complete/);
});

test('aos sign explains the way out of a blocked order and offers nothing to close for it', async () => {
  const root = running(report('not complete', 'blocked'));
  assert.equal(finish(root, 'blocked', ['--reason', 'no access to the server']).status, 0);
  const lines = [];
  const asked = [];
  const r = await sign(root, { isTTY: true, ask: async (q) => { asked.push(q); return 'CLOSE'; }, out: (s) => lines.push(s), push: false });
  assert.deepEqual(r.signed, []);
  assert.equal(asked.length, 0, 'nothing is offered to close');
  const line = lines.filter((l) => /ORD-0001/.test(l) && /blocked/.test(l));
  assert.equal(line.length, 1, lines.join('\n'));
  assert.match(line[0], /no access to the server/);
  assert.match(line[0], /resume-order ORD-0001 --reason "<[^>]+>"/);
  assert.equal(state(root), 'blocked');
});

test('the rules block says it: only the review of the owner missing is done; blocked is for what prevents the work', () => {
  const line = blockTemplate().split('\n').find((l) => /only the owner's review is missing/.test(l));
  assert.ok(line);
  assert.match(line, /`done`/);
  assert.match(line, /`blocked` is for something that prevents the work/);
});
