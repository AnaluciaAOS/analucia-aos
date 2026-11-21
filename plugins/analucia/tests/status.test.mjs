// ORD-0042 part 6 (OBS-158): `aos status`, the event `decision.recorded`, the chain from the decision to the outcome
// and the metric: for each order, the minutes from the decision to the first run and the owner steps in between.
// Measured from the log, never estimated; an order with no recorded decision says so.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { enums } from '../lib/enums.mjs';
import { hashLF } from '../lib/lock.mjs';
import { appendEvent, logPath, readLog } from '../lib/log.mjs';
import { buildQueue, queueText } from '../lib/queue.mjs';
import { sign } from '../lib/sign.mjs';
import { replay } from '../lib/state.mjs';
import { CHAIN_LINKS, chainOf, metricOf } from '../lib/status.mjs';
import { validateEvent, validateOrderText } from '../lib/validate.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const baseEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
delete baseEnv.CLAUDE_PROJECT_DIR;
delete baseEnv.CLAUDE_CODE_SESSION_ID;
const aos = (root, args, session) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input: '', env: session ? { ...baseEnv, CLAUDE_CODE_SESSION_ID: session } : baseEnv });
const ORDER = (id, extra = []) => ['---', `id: ${id}`, `title: Title of ${id}`, 'kind: fix', 'created: 2026-11-16', 'budget_max_minutes: 30', 'budget_max_attempts: 3', 'risk: low', 'cost_effect: none', ...extra, '---', '', '## Acceptance criteria', '', '- [ ] x', ''].join('\n');
const VERIFY = (id) => `${JSON.stringify({ order: id, checks: [{ name: 'c', run: 'exit 0', expect_exit: 0 }] })}\n`;
const at = (hhmm) => new Date(`2026-11-16T${hhmm}:00-05:00`);

function project() {
  const root = mkdtempSync(join(tmpdir(), 'aos-status-'));
  const a = join(root, '.analucia');
  for (const d of ['orders', 'verify', 'drafts', 'evidence']) mkdirSync(join(a, d), { recursive: true });
  writeFileSync(join(a, 'project.json'), '{"wip_limit":3,"locale":"en","project_code":"SHOP"}\n');
  writeFileSync(logPath(root), '');
  writeFileSync(join(a, 'evidence', 'report.md'), '# r\n\n## Evidencia\n\nx\n\nOUTCOME: done\n');
  return root;
}
// An order placed and queued at fixed times (by the director's events), locked.
function queued(root, id, time = '09:00') {
  writeFileSync(join(root, '.analucia', 'orders', `${id}.md`), ORDER(id));
  writeFileSync(join(root, '.analucia', 'verify', `${id}.json`), VERIFY(id));
  const lockPath = join(root, '.analucia', 'director.lock');
  let lock = { files: {} };
  try { lock = JSON.parse(readFileSync(lockPath, 'utf8')); } catch { /* first order */ }
  for (const rel of [`.analucia/orders/${id}.md`, `.analucia/verify/${id}.json`]) lock.files[rel] = hashLF(readFileSync(join(root, rel)));
  writeFileSync(lockPath, JSON.stringify(lock));
  const now = at(time);
  appendEvent(root, { type: 'record.created', actor: 'director', subject: id }, { now });
  appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: id, payload: { from: 'draft', to: 'ready' } }, { now });
  appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: id, payload: { from: 'ready', to: 'queued' } }, { now });
}
const lastLine = (r) => r.stdout.trimEnd().split('\n').at(-1);

test('decision.recorded: a new event type, written by aos decision record for one or several orders', () => {
  assert.ok(enums.event_types.includes('decision.recorded'));
  const root = project();
  queued(root, 'SHOP-0001');
  queued(root, 'SHOP-0002');
  const r = aos(root, ['decision', 'record', '--text', 'Sell the summer stock at cost', '--source', 'notes/meeting.md', '--order', 'SHOP-0001', '--order', 'SHOP-0002']);
  assert.equal(r.status, 0, r.stderr);
  const e = readLog(root).events.at(-1);
  assert.deepEqual([e.type, e.actor, e.subject], ['decision.recorded', 'director', null]);
  assert.deepEqual(e.payload, { text: 'Sell the summer stock at cost', source: 'notes/meeting.md', orders: ['SHOP-0001', 'SHOP-0002'] });
  const one = aos(root, ['decision', 'record', '--text', 'One order only', '--order', 'SHOP-0001']);
  assert.equal(one.status, 0, one.stderr);
  assert.equal(readLog(root).events.at(-1).subject, 'SHOP-0001');
  // The text and at least one order are required; the payload is validated like every other event.
  assert.equal(aos(root, ['decision', 'record', '--order', 'SHOP-0001']).status, 2);
  assert.equal(aos(root, ['decision', 'record', '--text', 'x']).status, 2);
  const bad = (payload, actor = 'director') => validateEvent({ id: '01M745MDRPKD0464G89947VEF6', ts: '2026-11-16T10:00:00.000-05:00', type: 'decision.recorded', actor, subject: null, payload, prev: null }).map((x) => x.code);
  assert.deepEqual(bad({ text: 'x', orders: ['SHOP-0001'] }), []);
  assert.deepEqual(bad({ text: 'x', orders: ['SHOP-0001'], business_rules: ['for a cost of 8 the price is 22'] }, 'owner'), []);
  assert.ok(bad({ orders: ['SHOP-0001'] }).length, 'no text');
  assert.ok(bad({ text: 'x', orders: ['not an id'] }).length, 'a bad order id');
  assert.ok(bad({ text: 'x', orders: ['SHOP-0001'] }, 'executor').length, 'an executor does not record a decision');
});

test('the chain: decision → placed → admitted → each run → its evidence → its outcome → verified → signed, also as JSON', async () => {
  assert.deepEqual(CHAIN_LINKS, ['decision', 'placed', 'admitted', 'run', 'evidence', 'outcome', 'verified', 'signed']);
  const root = project();
  queued(root, 'SHOP-0001', '09:00');
  appendEvent(root, { type: 'decision.recorded', actor: 'director', subject: 'SHOP-0001', payload: { text: 'Do it', source: null, orders: ['SHOP-0001'] } }, { now: at('08:30') });
  assert.equal(aos(root, ['run', 'start', 'SHOP-0001']).status, 0);
  assert.equal(aos(root, ['run', 'finish', 'SHOP-0001', '--outcome', 'budget_exhausted', '--evidence', '.analucia/evidence/report.md']).status, 0);
  assert.equal(aos(root, ['run', 'start', 'SHOP-0001']).status, 0);
  assert.equal(aos(root, ['run', 'finish', 'SHOP-0001', '--outcome', 'done', '--evidence', '.analucia/evidence/report.md']).status, 0);
  await sign(root, { isTTY: true, push: false, out: () => {}, ask: async () => 'CLOSE' });
  const links = chainOf(readLog(root).events, 'SHOP-0001');
  assert.deepEqual(links.map((l) => l.link), ['decision', 'placed', 'admitted', 'run', 'evidence', 'outcome', 'run', 'evidence', 'outcome', 'verified', 'signed']);
  for (const l of links) assert.match(l.ts, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/, l.link);
  assert.equal(links[0].ts.slice(11, 16), '08:30');
  // As JSON: one array of { link, ts }, nothing else on the output.
  const json = aos(root, ['status', 'SHOP-0001', '--chain', '--json']);
  assert.equal(json.status, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.deepEqual(parsed.map((l) => Object.keys(l)), Array(11).fill(['link', 'ts']));
  assert.deepEqual(parsed.map((l) => l.link), links.map((l) => l.link));
  // As text: one line per link with its time, then the closing line.
  const text = aos(root, ['status', 'SHOP-0001', '--chain']);
  assert.equal(text.status, 0);
  const lines = text.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 12);
  assert.match(lines[0], /^decision +2026-11-16T08:30:00/);
  assert.match(lines[5], /^outcome .*budget_exhausted/);
  assert.match(lines.at(-1), /^OK: the chain of SHOP-0001 has 11 link\(s\)/);
  // An order with no recorded decision: the chain starts at the placement and says nothing it does not know.
  queued(root, 'SHOP-0002');
  assert.deepEqual(chainOf(readLog(root).events, 'SHOP-0002').map((l) => l.link), ['placed', 'admitted']);
});

test('the metric: minutes from the decision to the first run, and the owner steps in between; nothing invented', async () => {
  const root = project();
  // The owner's step: he places a draft that carries its decision. One step, recorded by the placement itself.
  writeFileSync(join(root, '.analucia', 'drafts', 'SHOP-0001.md'), ORDER('SHOP-0001', ['decision: Sell the summer stock at cost']));
  writeFileSync(join(root, '.analucia', 'drafts', 'SHOP-0001.json'), VERIFY('SHOP-0001'));
  assert.deepEqual(validateOrderText(ORDER('SHOP-0001', ['decision: Sell the summer stock at cost']), 'SHOP-0001.md', { pinned: true }), []);
  assert.ok(validateOrderText(ORDER('SHOP-0001', ['decision: [a, b]']), 'SHOP-0001.md', { pinned: true }).length, 'one line of text');
  const placed = await sign(root, { isTTY: true, push: false, out: () => {}, ask: async () => 'PLACE', now: at('10:00') });
  assert.deepEqual(placed.placed, ['SHOP-0001']);
  const decision = readLog(root).events.find((e) => e.type === 'decision.recorded');
  assert.deepEqual([decision.actor, decision.subject, decision.payload.text, decision.payload.orders], ['owner', 'SHOP-0001', 'Sell the summer stock at cost', ['SHOP-0001']]);
  assert.deepEqual(metricOf(readLog(root).events, 'SHOP-0001'), { decision: decision.ts, first_run: null, minutes: null, owner_steps: 1 });
  appendEvent(root, { type: 'order.state_changed', actor: 'executor', subject: 'SHOP-0001', payload: { from: 'queued', to: 'active' } }, { now: at('10:25') });
  appendEvent(root, { type: 'run.started', actor: 'executor', subject: 'SHOP-0001', payload: { run: 1 } }, { now: at('10:25') });
  const m = metricOf(readLog(root).events, 'SHOP-0001');
  assert.deepEqual([m.minutes, m.owner_steps], [25, 1], 'one owner step from the decision to the executor');
  // A decision recorded by the director, then two separate owner steps before the run: 2 steps.
  queued(root, 'SHOP-0002', '11:00');
  appendEvent(root, { type: 'decision.recorded', actor: 'director', subject: 'SHOP-0002', payload: { text: 'x', source: null, orders: ['SHOP-0002'] } }, { now: at('09:00') });
  appendEvent(root, { type: 'operation.logged', actor: 'owner', subject: null, payload: { operation: 'onboarding', changed: [] } }, { now: at('11:10') });
  appendEvent(root, { type: 'operation.logged', actor: 'owner', subject: null, payload: { operation: 'onboarding', changed: [] } }, { now: at('11:20') });
  appendEvent(root, { type: 'order.state_changed', actor: 'executor', subject: 'SHOP-0002', payload: { from: 'queued', to: 'active' } }, { now: at('11:07') });
  appendEvent(root, { type: 'run.started', actor: 'executor', subject: 'SHOP-0002', payload: { run: 1 } }, { now: at('11:07') });
  assert.deepEqual([metricOf(readLog(root).events, 'SHOP-0002').minutes, metricOf(readLog(root).events, 'SHOP-0002').owner_steps], [127, 2]);
  // No decision: said, not invented.
  queued(root, 'SHOP-0003', '12:00');
  assert.equal(metricOf(readLog(root).events, 'SHOP-0003'), null);
  const r = aos(root, ['status', '--metric']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^SHOP-0001: 25 min from the decision to the first run; 1 owner step\(s\) in between \(target 1\)$/m);
  assert.match(r.stdout, /^SHOP-0002: 127 min from the decision to the first run; 2 owner step\(s\) in between \(target 1\)$/m);
  assert.match(r.stdout, /^SHOP-0003: no decision was recorded for this order$/m);
  assert.match(lastLine(r), /^OK: 2 of 3 order\(s\) have a recorded decision$/);
  // The queue view shows it next to the order.
  const queue = buildQueue(root, replay(readLog(root).events).orders);
  assert.match(queueText(queue, 'en'), /SHOP-0001 — .*decision to first run: 25 min, 1 owner step\(s\)/);
});

test('aos status: one line per order that is not closed, with its stage, who holds it, why and since when; then the closing line', () => {
  const root = project();
  queued(root, 'SHOP-0001', '09:00');
  queued(root, 'SHOP-0002', '09:05');
  queued(root, 'SHOP-0003', '09:10');
  assert.equal(aos(root, ['run', 'start', 'SHOP-0001']).status, 0);
  assert.equal(aos(root, ['run', 'finish', 'SHOP-0001', '--outcome', 'needs_decision', '--evidence', '.analucia/evidence/report.md', '--reason', 'the price rule is not confirmed']).status, 0);
  assert.equal(aos(root, ['run', 'start', 'SHOP-0002'], 'session-A').status, 0);
  const r = aos(root, ['status']);
  assert.equal(r.status, 0, r.stderr);
  // ORD-0043 part 6: the first line says who waits for whom; the rest is as before.
  // ORD-0043 part 15: the second line names the DETENER launcher and the stop word.
  const [waits, stop, ...lines] = r.stdout.trimEnd().split('\n');
  assert.match(stop, /DETENER.*STOP/);
  assert.equal(waits, 'Waiting — owner 0 · director 1: decide SHOP-0001 · executor 1: finish SHOP-0002');
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^SHOP-0001 — blocked .* — held by director — the price rule is not confirmed — since \d{4}-\d{2}-\d{2}T/); // the pause is written at the time of the test, whatever the day (ORD-0043)
  assert.match(lines[1], /^SHOP-0002 — .* — held by executor \(EJECUTOR SHOP, session session-A\) — .* — since /);
  assert.match(lines[2], /^SHOP-0003 — .* — held by executor — /);
  assert.equal(lines[3], 'OK: 3 order(s) not closed');
  // The detail of one: the same facts, the single next step (the line of aos next), and the closing line.
  const one = aos(root, ['status', 'SHOP-0001']);
  assert.equal(one.status, 0);
  assert.match(one.stdout, /^SHOP-0001 — blocked/m);
  assert.match(one.stdout, /^Next \(/m);
  assert.equal(one.stdout.split('\n').find((l) => l.startsWith('Next (')), aos(root, ['next']).stdout.trimEnd());
  assert.match(lastLine(one), /^OK: SHOP-0001 is blocked/);
  // An unknown order: an error with its next line, no OK line.
  const none = aos(root, ['status', 'SHOP-0099']);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /E_NO_ORDER/);
  assert.doesNotMatch(none.stdout, /^OK: /m);
  // Nothing open at all.
  const empty = project();
  assert.equal(aos(empty, ['status']).stdout, 'Waiting — owner 0 · director 0 · executor 0\nTo stop everything at once: click DETENER in the project folder, or send STOP as your whole message.\nOK: 0 order(s) not closed\n');
});

test('a closed order: how long each stage took', async () => {
  const root = project();
  queued(root, 'SHOP-0001', '09:00');
  appendEvent(root, { type: 'order.state_changed', actor: 'executor', subject: 'SHOP-0001', payload: { from: 'queued', to: 'active' } }, { now: at('09:30') });
  appendEvent(root, { type: 'run.started', actor: 'executor', subject: 'SHOP-0001', payload: { run: 1 } }, { now: at('09:30') });
  appendEvent(root, { type: 'run.finished', actor: 'executor', subject: 'SHOP-0001', payload: { run: 1, outcome: 'done' } }, { now: at('11:45') });
  appendEvent(root, { type: 'order.state_changed', actor: 'executor', subject: 'SHOP-0001', payload: { from: 'active', to: 'delivered' } }, { now: at('11:45') });
  appendEvent(root, { type: 'order.state_changed', actor: 'system', subject: 'SHOP-0001', payload: { from: 'delivered', to: 'verified' } }, { now: at('12:00') });
  appendEvent(root, { type: 'order.state_changed', actor: 'owner', subject: 'SHOP-0001', payload: { from: 'verified', to: 'closed' } }, { now: at('12:10') });
  const r = aos(root, ['status', 'SHOP-0001']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /queued 30 min/);
  assert.match(r.stdout, /active 2 h 15 min/);
  assert.match(r.stdout, /delivered 15 min/);
  assert.match(r.stdout, /verified 10 min/);
  assert.match(lastLine(r), /^OK: SHOP-0001 is closed/);
  assert.equal(aos(root, ['status']).stdout, 'Waiting — owner 0 · director 0 · executor 0\nTo stop everything at once: click DETENER in the project folder, or send STOP as your whole message.\nOK: 0 order(s) not closed\n', 'a closed order is not in the list');
});
