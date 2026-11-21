// ORD-0042 part 11 (OBS-159): consumption per order. Built the second way of the order: a hook does not receive, in
// its input, the tokens or the cost a session has used (read in the hooks reference and tried on Claude Code
// 2.1.277 in a scratch configuration), so `aos status --metric` shows what the log does know for each order — the
// number of sessions, the number of runs and the minutes of work — and says that tokens are not known.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { blockTemplate } from '../lib/guards.mjs';
import { appendEvent, logPath, readLog } from '../lib/log.mjs';
import { consumptionOf } from '../lib/status.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env };
delete env.CLAUDE_PROJECT_DIR;
delete env.CLAUDE_CODE_SESSION_ID;
const aos = (root, args) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input: '', env });
const at = (hhmm) => new Date(`2026-11-16T${hhmm}:00-05:00`);

function project() {
  const root = mkdtempSync(join(tmpdir(), 'aos-consumption-'));
  mkdirSync(join(root, '.analucia'), { recursive: true });
  writeFileSync(join(root, '.analucia', 'project.json'), '{"wip_limit":2,"locale":"en"}\n');
  writeFileSync(logPath(root), '');
  return root;
}
const ev = (root, type, actor, subject, payload, time, agent) => appendEvent(root, { type, actor, subject, payload, ...(agent ? { agent } : {}) }, { now: at(time) });
function order(root, id, time) {
  ev(root, 'record.created', 'director', id, {}, time);
  ev(root, 'order.state_changed', 'director', id, { from: 'draft', to: 'ready' }, time);
  ev(root, 'order.state_changed', 'director', id, { from: 'ready', to: 'queued' }, time);
}
const session = (root, id, sid, start, end) => {
  ev(root, 'session.start', 'system', id, { session: sid, order: id, provider: 'claude-code', source: 'startup' }, start, { tool: 'claude-code', session: sid });
  if (end) ev(root, 'session.end', 'system', id, { session: sid, order: id, provider: 'claude-code', reason: 'other' }, end, { tool: 'claude-code', session: sid });
};
const run = (root, id, n, start, end, outcome = 'budget_exhausted') => {
  ev(root, 'order.state_changed', 'executor', id, { from: 'queued', to: 'active' }, start);
  ev(root, 'run.started', 'executor', id, { run: n }, start);
  if (!end) return;
  ev(root, 'run.finished', 'executor', id, { run: n, outcome }, end);
  ev(root, 'order.state_changed', 'executor', id, { from: 'active', to: 'queued', reason: 'more to do' }, end);
};

test('what the log knows for each order: sessions, runs and minutes of work; tokens are not known', () => {
  const root = project();
  order(root, 'ORD-0001', '09:00');
  run(root, 'ORD-0001', 1, '09:10', '10:40');
  session(root, 'ORD-0001', 'session-A', '09:05', '10:45');
  session(root, 'ORD-0001', 'session-B', '11:00', '11:50');
  session(root, 'ORD-0001', 'session-A', '12:00'); // the same session resumed: still one session
  run(root, 'ORD-0001', 2, '11:05', '11:35');
  assert.deepEqual(consumptionOf(readLog(root).events, 'ORD-0001'), { sessions: 2, runs: 2, minutes: 120, open_run: false, tokens: null });
  // An order with a run still open: its minutes count the finished runs only, and it says a run is open.
  order(root, 'ORD-0002', '13:00');
  run(root, 'ORD-0002', 1, '13:10');
  assert.deepEqual(consumptionOf(readLog(root).events, 'ORD-0002'), { sessions: 0, runs: 1, minutes: 0, open_run: true, tokens: null });
  order(root, 'ORD-0003', '14:00');
  assert.deepEqual(consumptionOf(readLog(root).events, 'ORD-0003'), { sessions: 0, runs: 0, minutes: 0, open_run: false, tokens: null });
});

test('aos status --metric shows it next to the minutes and the owner steps of each order', () => {
  const root = project();
  order(root, 'ORD-0001', '09:00');
  ev(root, 'decision.recorded', 'director', 'ORD-0001', { text: 'x', source: null, orders: ['ORD-0001'] }, '09:00');
  run(root, 'ORD-0001', 1, '09:10', '10:40');
  session(root, 'ORD-0001', 'session-A', '09:05', '10:45');
  order(root, 'ORD-0002', '11:00');
  const r = aos(root, ['status', '--metric']);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trimEnd().split('\n');
  assert.equal(lines[0], 'ORD-0001: 10 min from the decision to the first run; 0 owner step(s) in between (target 1)');
  assert.equal(lines[1], '  work recorded: 1 session(s), 1 run(s), 90 min in finished runs; tokens: not known (a hook receives no token or cost figure)');
  assert.equal(lines[2], 'ORD-0002: no decision was recorded for this order');
  assert.equal(lines[3], '  work recorded: 0 session(s), 0 run(s), 0 min in finished runs; tokens: not known (a hook receives no token or cost figure)');
  assert.match(lines.at(-1), /^OK: 1 of 2 order\(s\) have a recorded decision$/);
  // The detail of one order shows it too.
  assert.match(aos(root, ['status', 'ORD-0001']).stdout, /^ {2}work recorded: 1 session\(s\), 1 run\(s\), 90 min/m);
});

test('one sentence in the rules block and in the director entrypoint: one session per order or per role, and resume.md is the handoff', () => {
  const entry = readFileSync(fileURLToPath(new URL('../templates/director-entry.md', import.meta.url)), 'utf8');
  for (const text of [blockTemplate(), entry]) {
    const line = text.split('\n').find((l) => /one session per order or per role/i.test(l));
    assert.ok(line);
    assert.match(line, /resume\.md/);
    assert.match(line, /handoff/);
  }
});
