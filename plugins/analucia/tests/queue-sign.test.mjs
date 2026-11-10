// AMD-0005: the queue view, pause and resume by the executor, and one signing command for the owner.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hashLF } from '../lib/lock.mjs';
import { appendEvent, logPath, readLog } from '../lib/log.mjs';
import { pauseOrder, resumeOrder } from '../lib/lifecycle.mjs';
import { buildQueue } from '../lib/queue.mjs';
import { installLauncher, sign } from '../lib/sign.mjs';
import { replay } from '../lib/state.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
delete env.CLAUDE_PROJECT_DIR;
const aos = (root, args, input = '') => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input, env });
const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' });
const CONFIRM = { isTTY: true, ask: async () => 'CLOSE' };

// orders: [{ id, deps?, check?: 'pass' | 'fail' }]; all queued, locked, in a git repo with a local bare remote.
function project(orders, { locale = 'en', remote = true, attempts = 2 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aos-qs-'));
  const a = join(root, '.analucia');
  for (const d of ['orders', 'verify', 'evidence']) mkdirSync(join(a, d), { recursive: true });
  writeFileSync(join(a, 'project.json'), `${JSON.stringify({ wip_limit: 3, locale })}\n`);
  writeFileSync(logPath(root), '');
  writeFileSync(join(a, 'evidence', 'report.md'), 'evidence\n');
  const files = {};
  for (const o of orders) {
    const deps = o.deps ? [`depends_on: [${o.deps.join(', ')}]`] : [];
    writeFileSync(join(a, 'orders', `${o.id}.md`), ['---', `id: ${o.id}`, `title: Title of ${o.id}`, 'kind: fix', 'created: 2026-10-23', 'budget_max_minutes: 30', `budget_max_attempts: ${attempts}`, ...deps, '---', '', '## Acceptance criteria', '', '- [ ] x', ''].join('\n'));
    writeFileSync(join(a, 'verify', `${o.id}.json`), JSON.stringify({ order: o.id, checks: [{ name: 'the check', run: o.check === 'fail' ? 'exit 1' : 'exit 0', expect_exit: 0 }] }));
    for (const rel of [`.analucia/orders/${o.id}.md`, `.analucia/verify/${o.id}.json`]) files[rel] = hashLF(readFileSync(join(root, rel)));
    appendEvent(root, { type: 'record.created', actor: 'director', subject: o.id });
    appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: o.id, payload: { from: 'draft', to: 'ready' } });
    appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: o.id, payload: { from: 'ready', to: 'queued' } });
  }
  writeFileSync(join(a, 'director.lock'), JSON.stringify({ files }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  if (remote) {
    const bare = mkdtempSync(join(tmpdir(), 'aos-qs-bare-'));
    git(bare, 'init', '-q', '--bare');
    git(root, 'remote', 'add', 'origin', bare);
    git(root, 'push', '-q', '--no-verify', '-u', 'origin', 'main');
    return { root, bare };
  }
  return { root };
}
const deliver = (root, id) => {
  assert.equal(aos(root, ['run', 'start', id]).status, 0);
  assert.equal(aos(root, ['run', 'finish', id, '--outcome', 'done', '--evidence', '.analucia/evidence/report.md']).status, 0);
};
const stateOf = (root, id) => replay(readLog(root).events).orders[id].state;

test('the queue: dependencies first, then id; signed orders leave it; states in the owner words', () => {
  const { root } = project([{ id: 'ORD-0001', deps: ['ORD-0002'] }, { id: 'ORD-0002' }, { id: 'ORD-0003' }, { id: 'ORD-0004', deps: ['ORD-0009'] }], { locale: 'es' });
  const q = buildQueue(root, replay(readLog(root).events).orders);
  assert.deepEqual(q.map((x) => x.id), ['ORD-0002', 'ORD-0001', 'ORD-0003', 'ORD-0004'], 'a dependency outside the queue is satisfied');
  deliver(root, 'ORD-0002');
  assert.equal(aos(root, ['derive']).status, 0);
  const md = readFileSync(join(root, '.analucia', 'views', 'queue.md'), 'utf8');
  assert.match(md, /^# Cola/);
  assert.match(md, /1\. ORD-0002 — terminada por el ejecutor \(delivered\) — siguiente: system — Title of ORD-0002/);
  assert.match(md, /2\. ORD-0001 — en espera \(queued\) — siguiente: executor/);
  const state = JSON.parse(readFileSync(join(root, '.analucia', 'views', 'state.json'), 'utf8'));
  assert.deepEqual(state.queue.map((x) => [x.id, x.state, x.next]), [['ORD-0002', 'delivered', 'system'], ['ORD-0001', 'queued', 'executor'], ['ORD-0003', 'queued', 'executor'], ['ORD-0004', 'queued', 'executor']]);
  const again = readFileSync(join(root, '.analucia', 'views', 'queue.md'));
  aos(root, ['derive']);
  assert.deepEqual(readFileSync(join(root, '.analucia', 'views', 'queue.md')), again, 'deterministic');
});

test('pause needs a reason; it closes the run as blocked and leaves no run open', () => {
  const { root } = project([{ id: 'ORD-0001' }]);
  assert.equal(aos(root, ['run', 'start', 'ORD-0001']).status, 0);
  const before = readFileSync(logPath(root));
  const r = aos(root, ['pause', 'ORD-0001']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /aos pause: E_PAUSED_NO_REASON /);
  assert.deepEqual(readFileSync(logPath(root)), before, 'nothing written');
  assert.equal(aos(root, ['check-writeback']).status, 2, 'run open');
  const ok = aos(root, ['pause', 'ORD-0001', '--reason', 'waiting for the owner answer']);
  assert.equal(ok.status, 0, ok.stderr);
  const [finished, changed] = readLog(root).events.slice(-2);
  assert.deepEqual([finished.type, finished.payload.outcome, changed.payload.from, changed.payload.to, changed.payload.reason], ['run.finished', 'blocked', 'active', 'paused', 'waiting for the owner answer']);
  assert.equal(aos(root, ['check-writeback']).status, 0, 'a paused order has no open run');
  assert.equal(aos(root, ['validate']).status, 0);
});

test('pause then resume keeps the attempt budget: each resume is a counted run, and the budget still stops it', () => {
  const { root } = project([{ id: 'ORD-0001' }], { attempts: 2 });
  aos(root, ['run', 'start', 'ORD-0001']); // attempt 1
  pauseOrder(root, 'ORD-0001', { reason: 'pause 1' });
  const r = resumeOrder(root, 'ORD-0001'); // attempt 2
  assert.deepEqual([r.run, r.budget.max_attempts], [2, 2]);
  assert.equal(stateOf(root, 'ORD-0001'), 'active');
  assert.equal(readLog(root).events.at(-1).payload.resumed, true);
  pauseOrder(root, 'ORD-0001', { reason: 'pause 2' });
  const refused = aos(root, ['resume-order', 'ORD-0001']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /E_BUDGET/);
  assert.equal(stateOf(root, 'ORD-0001'), 'paused');
  assert.match(aos(root, ['resume-order', 'ORD-0009']).stderr, /E_NO_ORDER/);
  // The executor can finish normally after a resume.
  const { root: r2 } = project([{ id: 'ORD-0001' }], { attempts: 3 });
  aos(r2, ['run', 'start', 'ORD-0001']);
  pauseOrder(r2, 'ORD-0001', { reason: 'x' });
  resumeOrder(r2, 'ORD-0001');
  assert.equal(aos(r2, ['run', 'finish', 'ORD-0001', '--outcome', 'done', '--evidence', '.analucia/evidence/report.md']).status, 0);
  assert.equal(stateOf(r2, 'ORD-0001'), 'delivered');
});

test('the hook and the guards allow pause and resume-order during an open run', () => {
  const { root } = project([{ id: 'ORD-0001' }]);
  aos(root, ['run', 'start', 'ORD-0001']);
  for (const command of ['node plugins/analucia/bin/aos.mjs pause ORD-0001 --reason "wait"', 'node plugins/analucia/bin/aos.mjs resume-order ORD-0001']) {
    const r = spawnSync(process.execPath, [AOS, 'hook', 'pre-tool-use', '--root', root], { encoding: 'utf8', env, input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: root }) });
    assert.equal(r.status, 0, command);
  }
});

test('aos sign closes only the orders that passed verify; a failed order stays open; owner.signed, commit and push', async () => {
  const { root, bare } = project([{ id: 'ORD-0001' }, { id: 'ORD-0002', check: 'fail' }, { id: 'ORD-0003' }]);
  deliver(root, 'ORD-0001');
  deliver(root, 'ORD-0002');
  const lines = [];
  const r = await sign(root, { ...CONFIRM, out: (s) => lines.push(s) });
  assert.deepEqual(r.signed, ['ORD-0001']);
  assert.deepEqual(r.failed, ['ORD-0002']);
  assert.equal(stateOf(root, 'ORD-0001'), 'closed');
  assert.equal(stateOf(root, 'ORD-0002'), 'delivered', 'the failed order stays open');
  assert.equal(stateOf(root, 'ORD-0003'), 'queued');
  const text = lines.join('\n');
  assert.match(text, /Checking ORD-0001: Title of ORD-0001\n {2}passed: the check\n {2}evidence: \.analucia\/evidence\/ORD-0001\/verify-01\.txt/);
  assert.match(text, /ORD-0002 did not pass \(the check\); it stays open\./);
  assert.match(text, /Signed: ORD-0001\./);
  const signed = readLog(root).events.at(-1);
  assert.deepEqual([signed.type, signed.actor, signed.payload], ['owner.signed', 'owner', { orders: ['ORD-0001'], failed: ['ORD-0002'] }]);
  const closeEv = readLog(root).events.find((e) => e.payload?.to === 'closed');
  assert.equal(closeEv.actor, 'owner');
  assert.equal(r.pushed, true);
  const msg = git(root, 'log', '-1', '--format=%B').stdout;
  assert.match(msg, /^Sign-off: close ORD-0001 \(owner, aos sign\)/);
  assert.match(msg, /^Analucia-Order: ORD-0001$/m);
  assert.equal(git(bare, 'rev-parse', 'main').stdout.trim(), git(root, 'rev-parse', 'HEAD').stdout.trim());
  assert.equal(git(root, 'status', '--porcelain', '--', '.analucia/events.jsonl').stdout, '');
});

test('a refused push is reported in one line and nothing else happens', async () => {
  const { root } = project([{ id: 'ORD-0001' }], { remote: false });
  git(root, 'remote', 'add', 'origin', join(tmpdir(), 'aos-no-such-remote-xyz'));
  deliver(root, 'ORD-0001');
  const lines = [];
  const r = await sign(root, { ...CONFIRM, out: (s) => lines.push(s) });
  assert.equal(r.committed, true);
  assert.equal(r.pushed, false);
  const refused = lines.filter((l) => l.startsWith('The push was refused:'));
  assert.equal(refused.length, 1);
  assert.equal(lines.at(-1), refused[0], 'nothing after the refusal');
  assert.ok(!refused[0].includes('\n'));
});

test('a non-terminal call cannot close an order (E_OWNER_TTY), and anything but CLOSE closes nothing', async () => {
  const { root } = project([{ id: 'ORD-0001' }]);
  deliver(root, 'ORD-0001');
  const before = readFileSync(logPath(root));
  const r = aos(root, ['sign'], 'CLOSE\n');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /aos sign: E_OWNER_TTY /);
  assert.deepEqual(readFileSync(logPath(root)), before, 'no verify, no close, no event');
  await assert.rejects(sign(root, { isTTY: false, ask: async () => 'CLOSE' }), (x) => x.code === 'E_OWNER_TTY');
  await assert.rejects(sign(root, { isTTY: true, ask: async () => 'yes', out: () => {} }), (x) => x.code === 'E_NOT_CONFIRMED');
  assert.notEqual(stateOf(root, 'ORD-0001'), 'closed');
});

test('the launcher files are written, run aos sign, and contain no absolute personal path', () => {
  const { root } = project([]);
  const r = aos(root, ['sign', '--install-launcher']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /FIRMAR\.cmd: created\. Double-click it to sign\.\nFIRMAR\.sh: created\./);
  const cmd = readFileSync(join(root, 'FIRMAR.cmd'), 'utf8');
  const sh = readFileSync(join(root, 'FIRMAR.sh'), 'utf8');
  assert.match(cmd, /node "%AOS%" sign/);
  assert.match(sh, /node "\$AOS" sign/);
  assert.match(cmd, /\r\n/, 'Windows line endings for the .cmd');
  for (const text of [cmd, sh]) {
    for (const personal of [homedir(), homedir().replace(/\\/g, '/'), root, root.replace(/\\/g, '/'), tmpdir()]) assert.ok(!text.includes(personal), `contains ${personal}`);
    assert.doesNotMatch(text, /[A-Za-z]:\\Users\\|\/home\/|\/Users\//);
  }
  assert.deepEqual(installLauncher(root).map((x) => x.status), ['unchanged', 'unchanged']);
});
