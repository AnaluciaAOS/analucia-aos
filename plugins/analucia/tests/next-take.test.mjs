// ORD-0042 part 2 (OBS-140): the executor takes the next order by itself. `aos next` covers the two cases that needed
// a copied prompt: a queued order whose preflight passes, and a blocked order whose block has ended (an amendment
// to it was recorded after the block, or the ask it waited for was resolved). `aos resume-order` leaves `blocked`
// as well as `paused` when the block has ended, within the attempt budget. One order at a time, as before.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AOS_BIN } from '../lib/cli.mjs';
import { blockTemplate } from '../lib/guards.mjs';
import { hashLF } from '../lib/lock.mjs';
import { appendEvent, logPath, readLog } from '../lib/log.mjs';
import { replay } from '../lib/state.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const baseEnv = { ...process.env };
delete baseEnv.CLAUDE_PROJECT_DIR;
delete baseEnv.CLAUDE_CODE_SESSION_ID;
const aos = (root, args, session) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input: '', env: session ? { ...baseEnv, CLAUDE_CODE_SESSION_ID: session } : baseEnv });
const CMD = `node "${AOS_BIN}"`;
const next = (root) => {
  const r = aos(root, ['next']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trimEnd().split('\n').length, 1, r.stdout);
  return r.stdout.trimEnd();
};
const ORDER = (id, attempts) => ['---', `id: ${id}`, `title: Title of ${id}`, 'kind: fix', 'created: 2026-11-16', 'budget_max_minutes: 30', `budget_max_attempts: ${attempts}`, 'risk: low', 'cost_effect: none', '---', '', '## Acceptance criteria', '', '- [ ] x', ''].join('\n');

function project(ids = ['ORD-0001'], { preflight, attempts = 3 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aos-take-'));
  const a = join(root, '.analucia');
  for (const d of ['orders', 'verify', 'evidence', 'asks']) mkdirSync(join(a, d), { recursive: true });
  writeFileSync(join(a, 'project.json'), '{"wip_limit":1,"locale":"en"}\n');
  writeFileSync(logPath(root), '');
  writeFileSync(join(a, 'evidence', 'report.md'), '# r\n\n## Evidencia\n\nx\n\nOUTCOME: blocked\n');
  const files = {};
  for (const id of ids) {
    writeFileSync(join(a, 'orders', `${id}.md`), ORDER(id, attempts));
    writeFileSync(join(a, 'verify', `${id}.json`), JSON.stringify({ order: id, ...(preflight ? { preflight } : {}), checks: [{ name: 'c', run: 'exit 0', expect_exit: 0 }] }));
    for (const rel of [`.analucia/orders/${id}.md`, `.analucia/verify/${id}.json`]) files[rel] = hashLF(readFileSync(join(root, rel)));
    appendEvent(root, { type: 'record.created', actor: 'director', subject: id });
    appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: id, payload: { from: 'draft', to: 'ready' } });
    appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: id, payload: { from: 'ready', to: 'queued' } });
  }
  writeFileSync(join(a, 'director.lock'), JSON.stringify({ files }));
  return root;
}
const block = (root, id, extra = ['--reason', 'the spec and the order disagree']) => {
  assert.equal(aos(root, ['run', 'start', id]).status, 0);
  assert.equal(aos(root, ['run', 'finish', id, '--outcome', 'needs_decision', '--evidence', '.analucia/evidence/report.md', ...extra]).status, 0);
};
const order = (root, id) => replay(readLog(root).events).orders[id];
const log = (root) => readFileSync(logPath(root), 'utf8');

test('a queued order: aos next names it for the executor; a recorded failing preflight sends it to the director instead', () => {
  const plain = project();
  assert.equal(next(plain), `Next (executor): start ORD-0001 (Title of ORD-0001) with: ${CMD} run start ORD-0001`);
  // With a preflight: not tried yet, the start itself tries it; tried and passed, the same line.
  const root = project(['ORD-0001'], { preflight: [{ name: 'the tool is present', run: 'test -f tool.txt', expect_exit: 0 }] });
  assert.match(next(root), /^Next \(executor\): start ORD-0001 /);
  // Tried and failed: nothing to start; the director is told which preflight file says why.
  assert.equal(aos(root, ['preflight', 'ORD-0001']).status, 1);
  assert.equal(next(root), `Next (director): ORD-0001 is queued but its last preflight failed (.analucia/evidence/ORD-0001/preflight-01.txt). Put in place what it names, then check with: ${CMD} preflight ORD-0001`);
  writeFileSync(join(root, 'tool.txt'), 'x\n');
  assert.equal(aos(root, ['preflight', 'ORD-0001']).status, 0);
  assert.match(next(root), /^Next \(executor\): start ORD-0001 /);
  // aos next itself runs nothing and writes nothing.
  const before = log(root);
  next(root);
  assert.equal(log(root), before);
});

test('a blocked order whose block has ended by an amendment: aos next gives the command, and aos resume-order leaves blocked', () => {
  const root = project();
  block(root, 'ORD-0001');
  assert.match(next(root), /^Next \(director\): ORD-0001 is blocked \(the spec and the order disagree\)/);
  // Not ended yet: the command refuses and writes nothing.
  const before = log(root);
  const early = aos(root, ['resume-order', 'ORD-0001']);
  assert.equal(early.status, 1);
  assert.match(early.stderr, /aos resume-order: E_TRANSITION .*nothing in the log says the block has ended/);
  assert.equal(log(root), before);
  // The director records an amendment to the order: the block has ended.
  assert.equal(aos(root, ['event', 'append', '--type', 'record.amended', '--actor', 'director', '--subject', 'ORD-0001', '--payload', '{"amendment":"AMD-0001"}']).status, 0);
  assert.equal(next(root), `Next (executor): the block of ORD-0001 has ended (amendment AMD-0001). Read the order and its amendments, then continue with: ${CMD} resume-order ORD-0001`);
  const r = aos(root, ['resume-order', 'ORD-0001'], 'session-A');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ORD-0001: blocked -> active, run 2 of 3 started$/m);
  const events = readLog(root).events.slice(-2);
  assert.deepEqual(events.map((e) => [e.type, e.actor, e.agent?.session]), [['order.state_changed', 'executor', 'session-A'], ['run.started', 'executor', 'session-A']]);
  assert.deepEqual([events[0].payload.from, events[0].payload.to], ['blocked', 'active']);
  assert.match(events[0].payload.reason, /amendment AMD-0001/);
  assert.deepEqual([events[1].payload.run, events[1].payload.resumed], [2, true]);
  assert.equal(order(root, 'ORD-0001').state, 'active');
  assert.match(next(root), /^Next \(executor\): run 2 of ORD-0001 is open\./);
  assert.equal(aos(root, ['verify-log']).status, 0);
});

test('a blocked order whose ask was resolved by the owner: the block has ended', () => {
  const root = project();
  appendEvent(root, { type: 'record.created', actor: 'director', subject: 'ASK-0001' });
  appendEvent(root, { type: 'ask.opened', actor: 'director', subject: 'ASK-0001', payload: { kind: 'decide', title: 'Which one', options: ['approve', 'reject'] } });
  block(root, 'ORD-0001', ['--blocked-by', 'ASK-0001', '--reason', 'waits for the owner']);
  assert.equal(order(root, 'ORD-0001').blocked_by, 'ASK-0001');
  assert.equal(aos(root, ['resume-order', 'ORD-0001']).status, 1, 'the ask is still open');
  appendEvent(root, { type: 'ask.resolved', actor: 'owner', subject: 'ASK-0001', payload: { decision: 'approve', comment: '', via: 'sheet' } });
  assert.equal(next(root), `Next (executor): the block of ORD-0001 has ended (ASK-0001 answered). Read the order and its amendments, then continue with: ${CMD} resume-order ORD-0001`);
  assert.equal(aos(root, ['resume-order', 'ORD-0001']).status, 0);
  assert.equal(order(root, 'ORD-0001').state, 'active');
});

test('within the attempt budget, one order at a time, never from a director session; paused works as before', () => {
  // The budget: one attempt used, one allowed.
  const spent = project(['ORD-0001'], { attempts: 1 });
  block(spent, 'ORD-0001');
  appendEvent(spent, { type: 'record.amended', actor: 'director', subject: 'ORD-0001', payload: { amendment: 'AMD-0001' } });
  const over = aos(spent, ['resume-order', 'ORD-0001']);
  assert.equal(over.status, 1);
  assert.match(over.stderr, /E_BUDGET/);
  assert.equal(order(spent, 'ORD-0001').state, 'blocked');
  // One at a time: another order is active (wip_limit 1).
  const busy = project(['ORD-0001', 'ORD-0002']);
  block(busy, 'ORD-0001');
  appendEvent(busy, { type: 'record.amended', actor: 'director', subject: 'ORD-0001', payload: { amendment: 'AMD-0001' } });
  assert.equal(aos(busy, ['run', 'start', 'ORD-0002']).status, 0);
  const second = aos(busy, ['resume-order', 'ORD-0001']);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /E_WIP_LIMIT/);
  assert.equal(order(busy, 'ORD-0001').state, 'blocked');
  // A director session never takes a run.
  const dir = project();
  block(dir, 'ORD-0001');
  appendEvent(dir, { type: 'record.amended', actor: 'director', subject: 'ORD-0001', payload: { amendment: 'AMD-0001' } });
  assert.equal(aos(dir, ['role', 'declare', 'director', '--scope', '.analucia/drafts/**'], 'session-D').status, 0);
  assert.match(aos(dir, ['resume-order', 'ORD-0001'], 'session-D').stderr, /E_DIRECTOR_RUN/);
  // Paused, as before.
  const paused = project();
  assert.equal(aos(paused, ['run', 'start', 'ORD-0001']).status, 0);
  assert.equal(aos(paused, ['pause', 'ORD-0001', '--reason', 'lunch']).status, 0);
  const back = aos(paused, ['resume-order', 'ORD-0001']);
  assert.equal(back.status, 0, back.stderr);
  assert.match(back.stdout, /^ORD-0001: paused -> active, run 2 of 3 started$/m);
});

test('the rules block tells the executor: with no instruction, run aos next and do what it says', () => {
  const line = blockTemplate().split('\n').find((l) => /no instruction/i.test(l) && /aos next/.test(l));
  assert.ok(line, 'one line in the rules block');
  assert.match(line, /continue/);
  assert.match(line, /No prompt/i);
  assert.match(blockTemplate(), /aos resume-order ORD-NNNN.*blocked/);
});
