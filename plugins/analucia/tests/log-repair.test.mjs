// ORD-0042 part 4 (OBS-155): one-click repair of the log, for one kind of damage only. `aos repair-log` is owner only
// (E_OWNER_TTY, a typed word) and repairs only when all of this is true: the log does not verify; the version of the
// log in the last commit verifies; and every line of the working file after that committed version is a session
// line (session.start, session.end, role.declared). It puts back the committed version, keeps the removed lines in
// a file under .analucia/views/, records what it removed and verifies. In every other case it changes nothing.
// Every log here is a scratch log: the repair is never tried on the log of this repository.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LAUNCHER_NAMES, installLaunchers } from '../lib/launchers.mjs';
import { repairLog, repairPlan } from '../lib/log-repair.mjs';
import { appendEvent, logPath, readLog, verifyChain } from '../lib/log.mjs';
import { nextLine } from '../lib/next.mjs';
import { replay } from '../lib/state.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
delete env.CLAUDE_PROJECT_DIR;
delete env.CLAUDE_CODE_SESSION_ID;
const aos = (root, args, input = '') => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input, env });
const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' });
const lines = (root) => readFileSync(logPath(root), 'utf8').split('\n').filter(Boolean);

// A project whose log (an order queued and started) is committed.
function project() {
  const root = mkdtempSync(join(tmpdir(), 'aos-repair-'));
  mkdirSync(join(root, '.analucia', 'orders'), { recursive: true });
  writeFileSync(join(root, '.analucia', 'project.json'), '{"wip_limit":1,"locale":"en"}\n');
  writeFileSync(join(root, '.analucia', 'orders', 'ORD-0001.md'), ['---', 'id: ORD-0001', 'title: T', 'kind: fix', 'created: 2026-11-16', 'budget_max_minutes: 30', 'budget_max_attempts: 2', '---', '', '## Acceptance criteria', '', '- [ ] x', ''].join('\n'));
  writeFileSync(join(root, '.gitattributes'), '*.jsonl text eol=lf\n');
  writeFileSync(logPath(root), '');
  appendEvent(root, { type: 'record.created', actor: 'director', subject: 'ORD-0001' });
  appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: 'ORD-0001', payload: { from: 'draft', to: 'ready' } });
  appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: 'ORD-0001', payload: { from: 'ready', to: 'queued' } });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  return root;
}
const session = (root, type, id) => appendEvent(root, { type, actor: 'system', subject: null, agent: { tool: 'claude-code', session: id }, payload: type === 'session.start' ? { session: id, order: null, provider: 'claude-code', source: 'startup' } : { session: id, order: null, provider: 'claude-code', reason: 'other' } });
// The damage of OBS-155: a second writer appends a line computed from the same last line as the one before it.
function collide(root) {
  const all = lines(root);
  const twin = JSON.parse(all.at(-1));
  twin.id = `${twin.id.slice(0, -4)}ZZZZ`;
  twin.payload = { ...twin.payload, session: 'another-session' };
  twin.agent = { ...twin.agent, session: 'another-session' };
  appendFileSync(logPath(root), `${JSON.stringify(twin)}\n`);
}
const owner = (answers) => {
  const out = [];
  const prompts = [];
  return { isTTY: true, out: (s) => out.push(s), prompts, lines: out, ask: async (q) => { prompts.push(q); return answers.length ? answers.shift() : ''; } };
};

test('the repairable case: only uncommitted session lines are lost; the typed word puts back the committed log and records it', async () => {
  const root = project();
  appendEvent(root, { type: 'role.declared', actor: 'executor', subject: null, agent: { tool: 'claude-code', session: 's1' }, payload: { role: 'executor', source: 'startup' } });
  session(root, 'session.start', 's1');
  session(root, 'session.end', 's1');
  collide(root);
  assert.ok(verifyChain(readFileSync(logPath(root))), 'the log is broken');
  const plan = repairPlan(root);
  assert.equal(plan.repairable, true);
  assert.deepEqual([plan.committed, plan.removed, plan.kinds], [3, 4, { 'role.declared': 1, 'session.start': 1, 'session.end': 2 }]);
  // aos next sends the owner to the click (or the command), not the director to git.
  assert.match(nextLine(root, { explicit: true, locale: 'en' }), /^The event log is broken at line 7 \(E_CHAIN\), and only session lines that were not saved are affected\. Next \(owner\): /);
  // Anything but the word: nothing changes.
  const before = readFileSync(logPath(root));
  await assert.rejects(repairLog(root, owner(['yes'])), (x) => x.code === 'E_NOT_CONFIRMED');
  assert.deepEqual(readFileSync(logPath(root)), before);
  // The word.
  const o = owner(['REPAIR']);
  const r = await repairLog(root, o);
  assert.match(o.prompts[0], /4 session line\(s\)/);
  assert.match(o.prompts[0], /Type REPAIR/);
  assert.deepEqual([r.removed, r.committed], [4, 3]);
  assert.equal(verifyChain(readFileSync(logPath(root))), null, 'the chain is intact again');
  // The committed lines are byte for byte the committed ones, then one event that says what was removed and by whom.
  const committed = git(root, 'show', 'HEAD:.analucia/events.jsonl').stdout;
  assert.ok(readFileSync(logPath(root), 'utf8').startsWith(committed));
  const events = readLog(root).events;
  assert.equal(events.length, 4);
  assert.deepEqual([events[3].type, events[3].actor], ['operation.logged', 'owner']);
  assert.deepEqual(events[3].payload, { operation: 'log_repaired', removed: 4, kinds: { 'role.declared': 1, 'session.start': 1, 'session.end': 2 }, kept_in: r.kept_in });
  // The removed lines are kept, whole, under .analucia/views/, in a file named with the time.
  assert.match(r.kept_in, /^\.analucia\/views\/log-removed-\d{8}T\d{6}\.jsonl$/);
  const kept = readFileSync(join(root, r.kept_in), 'utf8').split('\n').filter(Boolean);
  assert.equal(kept.length, 4);
  assert.deepEqual(kept.map((l) => JSON.parse(l).type), ['role.declared', 'session.start', 'session.end', 'session.end']);
  // No order lost its state.
  assert.equal(replay(events).orders['ORD-0001'].state, 'queued');
  assert.equal(aos(root, ['verify-log']).status, 0);
  // Nothing left to repair: the command says so and changes nothing.
  await assert.rejects(repairLog(root, owner(['REPAIR'])), (x) => x.code === 'E_LOG_NOT_REPAIRABLE' && /verifies: there is nothing to repair/.test(x.message));
});

test('a lost order event: nothing is repaired, and the reason says which condition fails', async () => {
  const root = project();
  session(root, 'session.start', 's1');
  appendEvent(root, { type: 'order.state_changed', actor: 'executor', subject: 'ORD-0001', payload: { from: 'queued', to: 'active' } });
  appendEvent(root, { type: 'run.started', actor: 'executor', subject: 'ORD-0001', payload: { run: 1 } });
  session(root, 'session.end', 's1');
  collide(root);
  const before = readFileSync(logPath(root));
  const plan = repairPlan(root);
  assert.equal(plan.repairable, false);
  assert.equal(plan.condition, 3);
  const o = owner(['REPAIR']);
  await assert.rejects(repairLog(root, o), (x) => x.code === 'E_LOG_NOT_REPAIRABLE' && /condition 3/.test(x.message) && /2 line\(s\) that are not session lines \(order\.state_changed 1, run\.started 1\)/.test(x.message));
  assert.equal(o.prompts.length, 0, 'the word is not even asked');
  assert.deepEqual(readFileSync(logPath(root)), before);
  assert.equal(existsSync(join(root, '.analucia', 'views')), false);
  assert.match(nextLine(root, { explicit: true, locale: 'en' }), /Next \(director\): restore \.analucia\/events\.jsonl from git/);
});

test('a committed version that does not verify, a committed part that was changed, or no commit at all: nothing is repaired', async () => {
  // The committed version itself is broken.
  const root = project();
  session(root, 'session.end', 's1');
  collide(root);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'a broken log was committed');
  const a = repairPlan(root);
  assert.deepEqual([a.repairable, a.condition], [false, 2]);
  await assert.rejects(repairLog(root, owner(['REPAIR'])), (x) => x.code === 'E_LOG_NOT_REPAIRABLE' && /condition 2/.test(x.message));
  // A committed line was edited by hand: the working file no longer starts with the committed version.
  const edited = project();
  session(edited, 'session.end', 's1');
  writeFileSync(logPath(edited), readFileSync(logPath(edited), 'utf8').replace('"director"', '"Director"'));
  const b = repairPlan(edited);
  assert.deepEqual([b.repairable, b.condition], [false, 3]);
  const before = readFileSync(logPath(edited));
  await assert.rejects(repairLog(edited, owner(['REPAIR'])), (x) => x.code === 'E_LOG_NOT_REPAIRABLE');
  assert.deepEqual(readFileSync(logPath(edited)), before);
  // Not a git repository: there is no committed version to go back to.
  const bare = mkdtempSync(join(tmpdir(), 'aos-repair-nogit-'));
  mkdirSync(join(bare, '.analucia'));
  writeFileSync(join(bare, '.analucia', 'project.json'), '{"wip_limit":1}\n');
  writeFileSync(logPath(bare), 'not json\n');
  const c = repairPlan(bare);
  assert.deepEqual([c.repairable, c.condition], [false, 2]);
});

test('without a terminal it is refused, whatever is piped in; the REPARAR launcher is written with the others', () => {
  const root = project();
  session(root, 'session.end', 's1');
  collide(root);
  const before = readFileSync(logPath(root));
  const r = aos(root, ['repair-log'], 'REPAIR\n');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /aos repair-log: E_OWNER_TTY /);
  assert.match(r.stderr, /next \(owner\)/);
  assert.deepEqual(readFileSync(logPath(root)), before);
  assert.ok(LAUNCHER_NAMES.includes('REPARAR'));
  const dir = mkdtempSync(join(tmpdir(), 'aos-repair-launch-'));
  installLaunchers(dir, { locale: 'en' });
  const names = readdirSync(dir);
  assert.ok(names.includes('REPARAR.cmd') && names.includes('REPARAR.sh'));
  assert.match(readFileSync(join(dir, 'REPARAR.cmd'), 'utf8'), /" "%~dp0\." repair-log\r\n/);
  assert.match(readFileSync(join(dir, 'REPARAR.sh'), 'utf8'), /" "\$PWD" repair-log\n/);
});
