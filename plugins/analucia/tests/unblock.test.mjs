// ORD-0043 part 3 (OBS-162): leaving `blocked` with one command. ORD-0042 part 2 covered the block that ends by an
// amendment or an answered ask. The common case has neither: the owner did what the order waited for and nothing in
// the log says so. `aos resume-order <ID> --reason "<why the block has ended>"` (also `aos unblock`) writes the
// transition the state table allows, with the reason, and starts the next run, within the attempt budget and after
// the preflight. `aos next` names the exact line. Nobody writes that transition with `aos event append` again.
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
const aos = (root, args) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input: '', env: baseEnv });
const CMD = `node "${AOS_BIN}"`;
const ORDER = (id, attempts) => ['---', `id: ${id}`, `title: Title of ${id}`, 'kind: fix', 'created: 2026-11-16', 'budget_max_minutes: 30', `budget_max_attempts: ${attempts}`, 'risk: low', 'cost_effect: none', '---', '', '## Acceptance criteria', '', '- [ ] x', ''].join('\n');

// One order, blocked by its first run with a plain reason: no ask, no amendment.
function blocked({ attempts = 3, preflight } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aos-unblock-'));
  const a = join(root, '.analucia');
  for (const d of ['orders', 'verify', 'evidence']) mkdirSync(join(a, d), { recursive: true });
  writeFileSync(join(a, 'project.json'), '{"wip_limit":1,"locale":"en"}\n');
  writeFileSync(logPath(root), '');
  writeFileSync(join(a, 'evidence', 'report.md'), '# r\n\n## Evidencia\n\nx\n\nOUTCOME: blocked\n');
  const id = 'ORD-0001';
  writeFileSync(join(a, 'orders', `${id}.md`), ORDER(id, attempts));
  writeFileSync(join(a, 'verify', `${id}.json`), JSON.stringify({ order: id, ...(preflight ? { preflight } : {}), checks: [{ name: 'c', run: 'exit 0', expect_exit: 0 }] }));
  const files = {};
  for (const rel of [`.analucia/orders/${id}.md`, `.analucia/verify/${id}.json`]) files[rel] = hashLF(readFileSync(join(root, rel)));
  writeFileSync(join(a, 'director.lock'), JSON.stringify({ files }));
  appendEvent(root, { type: 'record.created', actor: 'director', subject: id });
  appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: id, payload: { from: 'draft', to: 'ready' } });
  appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: id, payload: { from: 'ready', to: 'queued' } });
  assert.equal(aos(root, ['run', 'start', id]).status, 0);
  assert.equal(aos(root, ['run', 'finish', id, '--outcome', 'blocked', '--evidence', '.analucia/evidence/report.md', '--reason', 'the owner must look at the price file']).status, 0);
  return root;
}
const order = (root) => replay(readLog(root).events).orders['ORD-0001'];
const log = (root) => readFileSync(logPath(root), 'utf8');

test('aos resume-order --reason leaves blocked when neither automatic condition holds, and starts the next run', () => {
  const root = blocked();
  assert.equal(order(root).state, 'blocked');
  // Without --reason it refuses as before, changes nothing, and the message gives the line.
  const before = log(root);
  const refused = aos(root, ['resume-order', 'ORD-0001']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /E_TRANSITION/);
  assert.match(refused.stderr, /resume-order ORD-0001 --reason "<why the block has ended>"/);
  assert.equal(log(root), before);
  // An empty reason is no reason.
  assert.equal(aos(root, ['resume-order', 'ORD-0001', '--reason', '   ']).status, 1);
  assert.equal(log(root), before);
  // With the reason: the transition the state table allows, with the reason, and the next run.
  const r = aos(root, ['resume-order', 'ORD-0001', '--reason', 'the owner looked at the price file']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ORD-0001: blocked -> active, run 2 of 3 started/);
  const events = readLog(root).events;
  const [change, started] = events.slice(-2);
  assert.deepEqual([change.type, change.actor, change.payload.from, change.payload.to], ['order.state_changed', 'executor', 'blocked', 'active']);
  assert.match(change.payload.reason, /the owner looked at the price file/);
  assert.deepEqual([started.type, started.payload.run, started.payload.resumed], ['run.started', 2, true]);
  assert.equal(order(root).state, 'active');
});

test('aos unblock is the same command under the name the owner asked for', () => {
  const root = blocked();
  const before = log(root);
  const refused = aos(root, ['unblock', 'ORD-0001']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /--reason "<why the block has ended>"/);
  assert.equal(log(root), before);
  const r = aos(root, ['unblock', 'ORD-0001', '--reason', 'the access was given']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ORD-0001: blocked -> active, run 2 of 3 started/);
  assert.match(readLog(root).events.at(-2).payload.reason, /the access was given/);
  // An order that is not blocked is not touched by it.
  const again = aos(root, ['unblock', 'ORD-0001', '--reason', 'the access was given']);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /E_TRANSITION/);
  assert.match(aos(root, ['unblock']).stderr, /usage: aos unblock/);
});

test('within the attempt budget and after the preflight: a spent budget or a failing preflight starts nothing', () => {
  const spent = blocked({ attempts: 1 });
  const over = aos(spent, ['resume-order', 'ORD-0001', '--reason', 'the owner looked at it']);
  assert.equal(over.status, 1);
  assert.match(over.stderr, /E_BUDGET/);
  assert.equal(order(spent).state, 'blocked');
  // A preflight that passed at the first run and fails now: nothing is written, no attempt is consumed.
  const root = blocked({ preflight: [{ name: 'the marker is absent', run: 'test ! -e marker', expect_exit: 0 }] });
  writeFileSync(join(root, 'marker'), 'x');
  const before = readLog(root).events.length;
  const r = aos(root, ['resume-order', 'ORD-0001', '--reason', 'the owner looked at it']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /E_PREFLIGHT_FAILED/);
  assert.equal(readLog(root).events.length, before);
  assert.equal(order(root).state, 'blocked');
});

test('aos next names the exact line for a blocked order: what it waits for, and the command that takes it out', () => {
  const root = blocked();
  const r = aos(root, ['next']);
  assert.equal(r.status, 0, r.stderr);
  const line = r.stdout.trimEnd();
  assert.equal(line.split('\n').length, 1);
  assert.equal(line, `Next (director): ORD-0001 is blocked (the owner must look at the price file). Decide how it continues: the answer it waits for, or a new draft order. When what it waits for is done, the executor takes it out with: ${CMD} resume-order ORD-0001 --reason "<why the block has ended>"`);
  // In the owner's language too.
  writeFileSync(join(root, '.analucia', 'project.json'), '{"wip_limit":1,"locale":"es"}\n');
  assert.match(aos(root, ['next']).stdout, /está bloqueada \(the owner must look at the price file\).* resume-order ORD-0001 --reason "<[^>]+>"/);
});

test('the rules block says it: the command with its reason, never aos event append', () => {
  const line = blockTemplate().split('\n').find((l) => /resume-order ORD-NNNN --reason/.test(l));
  assert.ok(line, 'the rules block names the command');
  assert.match(line, /aos unblock/);
  assert.match(line, /never .*`aos event append`/);
});
