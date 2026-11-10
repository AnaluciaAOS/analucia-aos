// AMD-0004: the owner's first hour, measured from synthetic logs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { appendEvent, logPath, readLog } from '../lib/log.mjs';
import { firstHour } from '../lib/metrics.mjs';
import { onboardingCompleted, onboardingStarted } from '../lib/onboarding.mjs';
import { validateTree } from '../lib/validate.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env };
delete env.CLAUDE_PROJECT_DIR;
const aos = (root, args) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input: '', env });

function project() {
  const root = mkdtempSync(join(tmpdir(), 'aos-metrics-'));
  mkdirSync(join(root, '.analucia', 'orders'), { recursive: true });
  writeFileSync(join(root, '.analucia', 'project.json'), '{"wip_limit":3}\n');
  writeFileSync(logPath(root), '');
  return root;
}
const at = (hhmm) => new Date(`2026-10-22T${hhmm}:00-05:00`);
const ev = (root, hhmm, type, actor, subject, payload = {}) => appendEvent(root, { type, actor, subject, payload }, { now: at(hhmm) });

// An order that reaches `verified`; `evidence` decides whether an evidence.attached is recorded.
function toVerified(root, id, hhmm, { evidence = true, runs = 1 } = {}) {
  ev(root, hhmm, 'record.created', 'director', id);
  ev(root, hhmm, 'order.state_changed', 'director', id, { from: 'draft', to: 'ready' });
  ev(root, hhmm, 'order.state_changed', 'director', id, { from: 'ready', to: 'queued' });
  ev(root, hhmm, 'order.state_changed', 'executor', id, { from: 'queued', to: 'active' });
  for (let r = 1; r <= runs; r++) {
    ev(root, hhmm, 'run.started', 'executor', id, { run: r });
    ev(root, hhmm, 'run.finished', 'executor', id, { run: r, outcome: 'done' });
  }
  if (evidence) ev(root, hhmm, 'evidence.attached', 'executor', id, { level: 'derived', path: 'report.md' });
  ev(root, hhmm, 'order.state_changed', 'executor', id, { from: 'active', to: 'delivered' });
  ev(root, hhmm, 'order.state_changed', 'system', id, { from: 'delivered', to: 'verified' });
}
const metric = (root) => firstHour(readLog(root).events);

test('no closed order gives not_reached', () => {
  const root = project();
  onboardingStarted(root, { now: at('09:00') });
  toVerified(root, 'ORD-0001', '09:30');
  const m = metric(root);
  assert.equal(m.status, 'not_reached');
  assert.equal(m.first_closed, null);
  assert.equal(m.elapsed, null);
  assert.equal(m.started.source, 'onboarding.started');
});

test('an order closed by the director does not count', () => {
  const root = project();
  onboardingStarted(root, { now: at('09:00') });
  toVerified(root, 'ORD-0001', '09:20');
  ev(root, '09:30', 'order.state_changed', 'owner', 'ORD-0001', { from: 'verified', to: 'closed' }); // establishes owner close works
  const counted = metric(root);
  assert.equal(counted.status, 'reached');
  const director = project();
  onboardingStarted(director, { now: at('09:00') });
  toVerified(director, 'ORD-0001', '09:20');
  appendEvent(director, { type: 'order.state_changed', actor: 'director', subject: 'ORD-0001', payload: { from: 'verified', to: 'closed', risk: 'low' } }, { now: at('09:40'), directorMayClose: new Set(['ORD-0001']) });
  assert.equal(metric(director).status, 'not_reached');
});

test('an order closed by the owner without evidence does not count', () => {
  const root = project();
  onboardingStarted(root, { now: at('09:00') });
  toVerified(root, 'ORD-0001', '09:10', { evidence: false });
  ev(root, '09:15', 'order.state_changed', 'owner', 'ORD-0001', { from: 'verified', to: 'closed' });
  assert.equal(metric(root).status, 'not_reached');
});

test('the first valid order gives the right elapsed minutes, orders and runs', () => {
  const root = project();
  ev(root, '08:00', 'operation.logged', 'owner', null, { operation: 'note' }); // before the start: not counted
  onboardingStarted(root, { now: at('09:00') });
  toVerified(root, 'ORD-0001', '09:10', { evidence: false });
  ev(root, '09:15', 'order.state_changed', 'owner', 'ORD-0001', { from: 'verified', to: 'closed' }); // no evidence: skipped
  toVerified(root, 'ORD-0002', '09:20', { runs: 2 });
  ev(root, '09:47', 'order.state_changed', 'owner', 'ORD-0002', { from: 'verified', to: 'closed' }); // the first that counts
  toVerified(root, 'ORD-0003', '10:00');
  ev(root, '10:30', 'order.state_changed', 'owner', 'ORD-0003', { from: 'verified', to: 'closed' });
  const m = metric(root);
  assert.equal(m.status, 'reached');
  assert.equal(m.first_closed.order, 'ORD-0002');
  assert.deepEqual(m.elapsed, { minutes: 47, orders: 2, runs: 3 });
  const r = aos(root, ['metrics', 'first-hour']);
  assert.equal(r.status, 0);
  assert.deepEqual(r.stdout.trim().split('\n').map((l) => l.split(':')[0]), ['started', 'first_closed', 'elapsed', 'status']);
  assert.match(r.stdout, /elapsed: 47 min · 2 orders · 3 runs\nstatus: reached/);
  assert.doesNotMatch(r.stdout, /target|good|bad|fast|slow/i, 'numbers only, no verdict');
});

test('a log with no onboarding.started uses the first event', () => {
  const root = project();
  ev(root, '07:30', 'operation.logged', 'owner', null, { operation: 'note' });
  toVerified(root, 'ORD-0001', '08:00');
  ev(root, '08:15', 'order.state_changed', 'owner', 'ORD-0001', { from: 'verified', to: 'closed' });
  const m = metric(root);
  assert.equal(m.started.source, 'first_event');
  assert.equal(m.started.line, 1);
  assert.equal(m.elapsed.minutes, 45);
});

test('the view is identical after a second aos derive', () => {
  const root = project();
  onboardingStarted(root, { now: at('09:00') });
  toVerified(root, 'ORD-0001', '09:05');
  ev(root, '09:20', 'order.state_changed', 'owner', 'ORD-0001', { from: 'verified', to: 'closed' });
  assert.equal(aos(root, ['derive']).status, 0);
  const first = readFileSync(join(root, '.analucia', 'views', 'first-hour.md'));
  assert.equal(aos(root, ['derive']).status, 0);
  assert.deepEqual(readFileSync(join(root, '.analucia', 'views', 'first-hour.md')), first);
  assert.match(first.toString(), /- elapsed: 20 min · 1 orders · 1 runs\n- status: reached/);
});

test('onboarding.started and onboarding.completed are registered event types, actor owner, with the passed count', () => {
  const root = mkdtempSync(join(tmpdir(), 'aos-metrics-fresh-'));
  // A brand-new project with no log yet.
  onboardingStarted(root, { now: at('09:00') });
  onboardingCompleted(root, [{ status: 'PASS' }, { status: 'PASS' }, { status: 'WARN' }], { now: at('09:05') });
  const [s, c] = readLog(root).events;
  assert.deepEqual([s.type, s.actor, c.type, c.actor], ['onboarding.started', 'owner', 'onboarding.completed', 'owner']);
  assert.deepEqual(c.payload, { checks_passed: 2, checks_warned: 1, checks_failed: 0, checks_total: 3 });
  writeFileSync(join(root, '.analucia', 'project.json'), '{"wip_limit":1}\n');
  assert.deepEqual(validateTree(root), []);
});
