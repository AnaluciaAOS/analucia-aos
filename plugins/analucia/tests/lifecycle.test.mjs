// SPEC-0002 §1–§3, §5: run start/finish, verify, close, director lock, budgets, format additions.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { close, runFinish, runStart } from '../lib/lifecycle.mjs';
import { hashLF } from '../lib/lock.mjs';
import { appendEvent, logPath, readLog } from '../lib/log.mjs';
import { replay } from '../lib/state.mjs';
import { validateEvent, validateFile, validateTree } from '../lib/validate.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const aos = (root, args, input) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input: input ?? '' });

const orderText = (id, { minutes = 30, attempts = 2 } = {}) => [
  '---', `id: ${id}`, 'title: Lifecycle fixture', 'kind: build', 'created: 2026-10-20',
  `budget_max_minutes: ${minutes}`, `budget_max_attempts: ${attempts}`, '---', '', `# ${id}`, '',
  '## Acceptance criteria', '', '- [ ] It works.', '',
].join('\n');

// A project with queued orders, verify files and a director lock over them.
function lifeProject({ ids = ['ORD-0001'], minutes, attempts, checks = [{ name: 'ok', run: 'exit 0', expect_exit: 0 }], wip = 1 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aos-life-'));
  const a = join(root, '.analucia');
  for (const d of ['orders', 'verify', 'evidence']) mkdirSync(join(a, d), { recursive: true });
  writeFileSync(join(a, 'project.json'), `${JSON.stringify({ wip_limit: wip, github_owner: 'example' })}\n`);
  writeFileSync(logPath(root), '');
  const files = {};
  for (const id of ids) {
    writeFileSync(join(a, 'orders', `${id}.md`), orderText(id, { minutes, attempts }));
    writeFileSync(join(a, 'verify', `${id}.json`), `${JSON.stringify({ order: id, checks }, null, 2)}\n`);
    for (const rel of [`.analucia/orders/${id}.md`, `.analucia/verify/${id}.json`]) files[rel] = hashLF(readFileSync(join(root, rel)));
    appendEvent(root, { type: 'record.created', actor: 'director', subject: id });
    appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: id, payload: { from: 'draft', to: 'ready' } });
    appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: id, payload: { from: 'ready', to: 'queued' } });
  }
  writeFileSync(join(a, 'director.lock'), `${JSON.stringify({ written_by: 'director', date: '2026-10-20', normalization: 'LF', files }, null, 2)}\n`);
  writeFileSync(join(a, 'evidence', 'report.md'), 'evidence\n');
  return root;
}
const EVIDENCE = '.analucia/evidence/report.md';
const stateOf = (root, id) => replay(readLog(root).events).orders[id];
const log = (root) => readFileSync(logPath(root));
const refused = (r, code) => {
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, new RegExp(`: ${code} `));
};

test('full cycle on a fixture: run start -> run finish done -> verify -> verified', () => {
  const root = lifeProject();
  const s = aos(root, ['run', 'start', 'ORD-0001']);
  assert.equal(s.status, 0, s.stderr);
  assert.equal(stateOf(root, 'ORD-0001').state, 'active');
  const f = aos(root, ['run', 'finish', 'ORD-0001', '--outcome', 'done', '--evidence', EVIDENCE]);
  assert.equal(f.status, 0, f.stderr);
  assert.equal(stateOf(root, 'ORD-0001').state, 'delivered');
  const v = aos(root, ['verify', 'ORD-0001']);
  assert.equal(v.status, 0, v.stdout + v.stderr);
  assert.match(v.stdout, /delivered -> verified/);
  const o = stateOf(root, 'ORD-0001');
  assert.equal(o.state, 'verified');
  assert.ok(o.evidence.some((e) => e.level === 'verified' && e.path === '.analucia/evidence/ORD-0001/verify-01.txt'));
  assert.match(readFileSync(join(root, '.analucia/evidence/ORD-0001/verify-01.txt'), 'utf8'), /exit 0 \(expected 0\): PASS/);
  const events = readLog(root).events;
  const started = events.find((e) => e.type === 'run.started');
  assert.deepEqual(started.payload, { run: 1, budget: { max_minutes: 30, max_attempts: 2 } });
  assert.equal(events.at(-1).actor, 'system');
  assert.deepEqual(validateTree(root), []);
});

test('E_NO_ORDER: run start without an order file', () => {
  const root = lifeProject();
  const before = log(root);
  refused(aos(root, ['run', 'start', 'ORD-0009']), 'E_NO_ORDER');
  assert.deepEqual(log(root), before);
});

test('E_TRANSITION: run start when the order is not queued; run finish without an open run', () => {
  const root = lifeProject();
  refused(aos(root, ['run', 'finish', 'ORD-0001', '--outcome', 'done', '--evidence', EVIDENCE]), 'E_TRANSITION');
  assert.equal(aos(root, ['run', 'start', 'ORD-0001']).status, 0);
  refused(aos(root, ['run', 'start', 'ORD-0001']), 'E_TRANSITION');
});

test('E_WIP_LIMIT: run start when the limit is full', () => {
  const root = lifeProject({ ids: ['ORD-0001', 'ORD-0002'] });
  assert.equal(aos(root, ['run', 'start', 'ORD-0001']).status, 0);
  const before = log(root);
  refused(aos(root, ['run', 'start', 'ORD-0002']), 'E_WIP_LIMIT');
  assert.deepEqual(log(root), before);
});

test('E_BUDGET: run start beyond budget_max_attempts is refused and recorded as budget_exhausted', () => {
  const root = lifeProject({ attempts: 1 });
  assert.equal(aos(root, ['run', 'start', 'ORD-0001']).status, 0);
  const f = aos(root, ['run', 'finish', 'ORD-0001', '--outcome', 'failed', '--evidence', EVIDENCE]);
  assert.equal(f.status, 0, f.stderr);
  assert.equal(stateOf(root, 'ORD-0001').state, 'queued');
  refused(aos(root, ['run', 'start', 'ORD-0001']), 'E_BUDGET');
  const last = readLog(root).events.at(-1);
  assert.equal(last.type, 'run.finished');
  assert.equal(last.payload.outcome, 'budget_exhausted');
  assert.equal(last.payload.refused_start, true);
  assert.equal(stateOf(root, 'ORD-0001').state, 'queued');
});

test('budget minutes: run finish after budget_max_minutes is recorded with over_budget', () => {
  const root = lifeProject({ minutes: 30 });
  const t0 = new Date('2026-10-20T10:00:00-05:00');
  runStart(root, 'ORD-0001', { now: t0 });
  const r = runFinish(root, 'ORD-0001', { outcome: 'done', evidence: EVIDENCE, now: new Date(t0.getTime() + 31 * 60000) });
  assert.equal(r.over_budget, true);
  const finished = readLog(root).events.find((e) => e.type === 'run.finished');
  assert.equal(finished.payload.over_budget, true);

  const ok = lifeProject({ minutes: 30 });
  runStart(ok, 'ORD-0001', { now: t0 });
  runFinish(ok, 'ORD-0001', { outcome: 'done', evidence: EVIDENCE, now: new Date(t0.getTime() + 29 * 60000) });
  assert.equal(readLog(ok).events.find((e) => e.type === 'run.finished').payload.over_budget, undefined);
});

test('run finish outcomes: blocked and needs_decision -> blocked, budget_exhausted and failed -> queued', () => {
  for (const [outcome, to, extra] of [
    ['blocked', 'blocked', ['--reason', 'waiting for credentials']],
    ['needs_decision', 'blocked', ['--blocked-by', 'ASK-0001']],
    ['budget_exhausted', 'queued', []],
    ['failed', 'queued', []],
  ]) {
    const root = lifeProject();
    aos(root, ['run', 'start', 'ORD-0001']);
    const r = aos(root, ['run', 'finish', 'ORD-0001', '--outcome', outcome, '--evidence', EVIDENCE, ...extra]);
    assert.equal(r.status, 0, `${outcome}: ${r.stderr}`);
    const o = stateOf(root, 'ORD-0001');
    assert.equal(o.state, to, outcome);
    if (outcome === 'blocked') assert.equal(o.blocked_by, 'waiting for credentials');
    if (outcome === 'needs_decision') assert.equal(o.blocked_by, 'ASK-0001');
  }
  const root = lifeProject();
  aos(root, ['run', 'start', 'ORD-0001']);
  refused(aos(root, ['run', 'finish', 'ORD-0001', '--outcome', 'almost', '--evidence', EVIDENCE]), 'E_OUTCOME_ENUM');
  refused(aos(root, ['run', 'finish', 'ORD-0001', '--outcome', 'done', '--evidence', 'nope.md']), 'E_FILE_MISSING');
});

test('E_DIRECTOR_FILE_CHANGED: verify refuses when one byte of a locked file changed (CRLF does not count)', () => {
  const root = lifeProject();
  aos(root, ['run', 'start', 'ORD-0001']);
  aos(root, ['run', 'finish', 'ORD-0001', '--outcome', 'done', '--evidence', EVIDENCE]);

  const crlf = mkdtempSync(join(tmpdir(), 'aos-crlf-'));
  cpSync(root, crlf, { recursive: true });
  const p = join(crlf, '.analucia/orders/ORD-0001.md');
  writeFileSync(p, readFileSync(p, 'utf8').replace(/\n/g, '\r\n'));
  assert.equal(aos(crlf, ['verify', 'ORD-0001']).status, 0, 'a CRLF checkout is not a change');

  const tampered = mkdtempSync(join(tmpdir(), 'aos-lock-'));
  cpSync(root, tampered, { recursive: true });
  const q = join(tampered, '.analucia/orders/ORD-0001.md');
  const buf = readFileSync(q);
  buf[buf.indexOf('works')] = 'W'.charCodeAt(0);
  writeFileSync(q, buf);
  const before = log(tampered);
  const r = aos(tampered, ['verify', 'ORD-0001']);
  refused(r, 'E_DIRECTOR_FILE_CHANGED');
  assert.match(r.stderr, /\.analucia\/orders\/ORD-0001\.md \(changed\)/);
  assert.deepEqual(log(tampered), before);
  assert.equal(stateOf(tampered, 'ORD-0001').state, 'delivered');
});

test('E_VERIFY_FAILED: a failing check attaches evidence and leaves the order delivered', () => {
  const root = lifeProject({ checks: [{ name: 'passes', run: 'echo fine', expect_exit: 0 }, { name: 'fails', run: 'echo bad; exit 3', expect_exit: 0 }] });
  aos(root, ['run', 'start', 'ORD-0001']);
  aos(root, ['run', 'finish', 'ORD-0001', '--outcome', 'done', '--evidence', EVIDENCE]);
  const r = aos(root, ['verify', 'ORD-0001']);
  refused(r, 'E_VERIFY_FAILED');
  assert.match(r.stdout, /FAIL fails \(exit 3, expected 0\)/);
  const o = stateOf(root, 'ORD-0001');
  assert.equal(o.state, 'delivered');
  const last = readLog(root).events.at(-1);
  assert.equal(last.type, 'evidence.attached');
  assert.equal(last.payload.passed, false);
});

test('E_OWNER_TTY: close refuses when stdin is not a TTY (piped CLOSE)', () => {
  const root = lifeProject();
  const before = log(root);
  const r = aos(root, ['close', 'ORD-0001'], 'CLOSE\n');
  refused(r, 'E_OWNER_TTY');
  assert.deepEqual(log(root), before);
});

test('close: owner at a terminal closes a verified batch; anything but CLOSE is refused', async () => {
  const root = lifeProject({ ids: ['ORD-0001', 'ORD-0002'], wip: 2 });
  for (const id of ['ORD-0001', 'ORD-0002']) {
    aos(root, ['run', 'start', id]);
    aos(root, ['run', 'finish', id, '--outcome', 'done', '--evidence', EVIDENCE]);
  }
  await assert.rejects(close(root, ['ORD-0001'], { isTTY: true, ask: async () => 'CLOSE' }), (x) => x.code === 'E_TRANSITION', 'not verified yet');
  for (const id of ['ORD-0001', 'ORD-0002']) assert.equal(aos(root, ['verify', id]).status, 0);
  await assert.rejects(close(root, ['ORD-0001'], { isTTY: true, ask: async () => 'yes' }), (x) => x.code === 'E_NOT_CONFIRMED');
  await assert.rejects(close(root, ['ORD-0001'], { isTTY: false, ask: async () => 'CLOSE' }), (x) => x.code === 'E_OWNER_TTY');
  await close(root, ['ORD-0001', 'ORD-0002'], { isTTY: true, ask: async () => 'CLOSE' });
  for (const id of ['ORD-0001', 'ORD-0002']) assert.equal(stateOf(root, id).state, 'closed');
  const closes = readLog(root).events.filter((e) => e.payload.to === 'closed');
  assert.ok(closes.length === 2 && closes.every((e) => e.actor === 'owner'));
});

test('format additions: verify-file schema, lock schema, agent field, github_owner', () => {
  const root = lifeProject();
  const codes = (path) => validateFile(path).map((e) => e.code);
  const v = join(root, '.analucia/verify/ORD-0001.json');
  writeFileSync(v, JSON.stringify({ order: 'ORD-0001', checks: [{ name: 'x', run: 'true', expect_exit: 0, extra: 1 }] }));
  assert.deepEqual(codes(v), ['E_UNKNOWN_KEY']);
  writeFileSync(v, JSON.stringify({ order: 'ORD-0002', checks: [{ name: 'x', run: 'true', expect_exit: 0 }] }));
  assert.deepEqual(codes(v), ['E_ID_MISMATCH']);
  writeFileSync(v, JSON.stringify({ order: 'ORD-0001', checks: [] }));
  assert.deepEqual(codes(v), ['E_FIELD_TYPE']);
  const l = join(root, '.analucia/director.lock');
  writeFileSync(l, JSON.stringify({ files: { 'core/X.md': 'abc' } }));
  assert.deepEqual(codes(l), ['E_FIELD_TYPE']);
  writeFileSync(l, JSON.stringify({ files: { '../escape.md': 'a'.repeat(64) } }));
  assert.deepEqual(codes(l), ['E_FIELD_TYPE']);
  writeFileSync(l, JSON.stringify({ written_by: 'director' }));
  assert.deepEqual(codes(l), ['E_MISSING_FIELD']);
  const base = { id: '01JAAAAAAAAAAAAAAAAAAAAAAA', ts: '2026-10-20T10:00:00-05:00', type: 'role.declared', actor: 'executor', subject: null, payload: { role: 'executor' }, prev: null };
  assert.deepEqual(validateEvent({ ...base, agent: { tool: 'claude-code', model: 'm', session: 's' } }), []);
  assert.deepEqual(validateEvent({ ...base, agent: { tool: 'claude-code', user: 'x' } }).map((e) => e.code), ['E_UNKNOWN_KEY']);
  assert.deepEqual(validateEvent({ ...base, agent: { tool: 1 } }).map((e) => e.code), ['E_FIELD_TYPE']);
  const p = join(root, '.analucia/project.json');
  writeFileSync(p, JSON.stringify({ wip_limit: 1, github_owner: 7 }));
  assert.deepEqual(codes(p), ['E_FIELD_TYPE']);
  assert.ok(existsSync(join(root, '.analucia/orders/ORD-0001.md')));
});
