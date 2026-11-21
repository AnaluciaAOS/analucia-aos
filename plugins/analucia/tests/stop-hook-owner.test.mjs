// ORD-0041 part 5 (AMD-0015 §5): the stop hook binds only the session that owns the run. `run.started` records the
// session that started the run when it is known; `aos check-writeback` blocks only that session while the run is
// open; another session ends freely and is told which order has a run open. With no session in the hook input, or a
// run with no recorded owner, every session is blocked as before. A session that declared the role director is never
// the owner of a run, is not blocked by one and cannot start one. A broken log blocks every session.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { appendEvent, logPath, readLog } from '../lib/log.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const baseEnv = { ...process.env };
delete baseEnv.CLAUDE_PROJECT_DIR;
delete baseEnv.CLAUDE_CODE_SESSION_ID;
const aos = (root, args, session) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input: '', env: session ? { ...baseEnv, CLAUDE_CODE_SESSION_ID: session } : baseEnv });
// The Stop hook of one session: the hook input on standard input, the project from CLAUDE_PROJECT_DIR.
const stop = (root, input) => spawnSync(process.execPath, [AOS, 'check-writeback'], { encoding: 'utf8', cwd: root, env: { ...baseEnv, CLAUDE_PROJECT_DIR: root }, input: input === undefined ? '' : JSON.stringify(input) });
const hookStart = (root, session, source = 'startup') => spawnSync(process.execPath, [AOS, 'hook', 'session-start'], { encoding: 'utf8', cwd: root, env: baseEnv, input: JSON.stringify({ cwd: root, session_id: session, source }) });
const ORDER = (id) => ['---', `id: ${id}`, 'title: T', 'kind: fix', 'created: 2026-11-14', 'budget_max_minutes: 30', 'budget_max_attempts: 3', '---', '', '## Acceptance criteria', '', '- [ ] x', ''].join('\n');

function project(ids = ['ORD-0001']) {
  const root = mkdtempSync(join(tmpdir(), 'aos-stop-'));
  mkdirSync(join(root, '.analucia', 'orders'), { recursive: true });
  writeFileSync(join(root, '.analucia', 'project.json'), '{"wip_limit":3,"locale":"en"}\n');
  writeFileSync(logPath(root), '');
  for (const id of ids) {
    writeFileSync(join(root, '.analucia', 'orders', `${id}.md`), ORDER(id));
    appendEvent(root, { type: 'record.created', actor: 'director', subject: id });
    appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: id, payload: { from: 'draft', to: 'ready' } });
    appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: id, payload: { from: 'ready', to: 'queued' } });
  }
  return root;
}
const log = (root) => readFileSync(logPath(root), 'utf8');

test('aos run start records the session that starts the run; only that session is blocked by the stop hook', () => {
  const root = project();
  const started = aos(root, ['run', 'start', 'ORD-0001'], 'session-A');
  assert.equal(started.status, 0, started.stderr);
  const event = readLog(root).events.at(-1);
  assert.deepEqual([event.type, event.agent.session], ['run.started', 'session-A']);
  // The owner of the run is blocked, with the command that records the outcome.
  const owner = stop(root, { session_id: 'session-A', hook_event_name: 'Stop' });
  assert.equal(owner.status, 2);
  assert.match(owner.stderr, /run 1 of ORD-0001 is still open/);
  assert.match(owner.stderr, /run finish ORD-0001/);
  // Another session ends freely, and is told which order has a run open and in which session.
  const other = stop(root, { session_id: 'session-B', hook_event_name: 'Stop' });
  assert.equal(other.status, 0, other.stderr);
  assert.equal(other.stderr, '');
  assert.equal(other.stdout.trimEnd().split('\n').length, 1);
  assert.match(other.stdout, /run 1 of ORD-0001 is open in another session \(session-A\); this session may end/);
  // PreCompact is never blocked (ORD-0043 part 1), not even for the owner of the run.
  assert.equal(stop(root, { session_id: 'session-B', hook_event_name: 'PreCompact' }).status, 0);
  assert.equal(stop(root, { session_id: 'session-A', hook_event_name: 'PreCompact' }).status, 0);
  // Finished: nobody is blocked and nothing is said.
  writeFileSync(join(root, 'report.md'), '# r\n\nOUTCOME: blocked\n');
  assert.equal(aos(root, ['run', 'finish', 'ORD-0001', '--outcome', 'blocked', '--evidence', 'report.md', '--reason', 'x'], 'session-A').status, 0);
  for (const s of ['session-A', 'session-B']) {
    const r = stop(root, { session_id: s, hook_event_name: 'Stop' });
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''], s);
  }
});

test('a run.started written with aos event append --agent carries its owner too (the form the verify file of the order uses)', () => {
  const root = project();
  const ev = (type, payload, agent) => {
    const args = ['event', 'append', '--type', type, '--actor', 'executor', '--subject', 'ORD-0001', '--payload', JSON.stringify(payload)];
    if (agent) args.push('--agent', JSON.stringify(agent));
    assert.equal(aos(root, args).status, 0, type);
  };
  ev('order.state_changed', { from: 'queued', to: 'active' });
  ev('run.started', { run: 1, budget: { max_minutes: 10, max_attempts: 1 } }, { tool: 'claude-code', session: 'session-A' });
  assert.equal(readLog(root).events.at(-1).agent.session, 'session-A');
  assert.equal(stop(root, { session_id: 'session-B', hook_event_name: 'Stop' }).status, 0);
  assert.equal(stop(root, { session_id: 'session-A', hook_event_name: 'Stop' }).status, 2);
  const bad = aos(root, ['event', 'append', '--type', 'role.declared', '--actor', 'executor', '--payload', '{"role":"executor"}', '--agent', 'not json']);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /E_JSON --agent is not valid JSON/);
});

test('with no session in the hook input, or a run with no recorded owner, every session is blocked as before', () => {
  const owned = project();
  assert.equal(aos(owned, ['run', 'start', 'ORD-0001'], 'session-A').status, 0);
  assert.equal(stop(owned).status, 2, 'no hook input at all');
  assert.equal(stop(owned, {}).status, 2, 'hook input without a session');
  assert.equal(stop(owned, { session_id: '' }).status, 2);
  const unowned = project();
  assert.equal(aos(unowned, ['run', 'start', 'ORD-0001']).status, 0, 'started outside a session: no owner recorded');
  assert.equal(readLog(unowned).events.at(-1).agent, undefined);
  for (const s of ['session-A', 'session-B']) assert.equal(stop(unowned, { session_id: s }).status, 2, s);
  // Two runs open, one owned by this session: blocked for that one, told about the other.
  const two = project(['ORD-0001', 'ORD-0002']);
  assert.equal(aos(two, ['run', 'start', 'ORD-0001'], 'session-A').status, 0);
  assert.equal(aos(two, ['run', 'start', 'ORD-0002'], 'session-B').status, 0);
  const a = stop(two, { session_id: 'session-A' });
  assert.equal(a.status, 2);
  assert.match(a.stderr, /run 1 of ORD-0001 is still open/);
  assert.doesNotMatch(a.stderr, /ORD-0002 is still open/);
  assert.equal(stop(two, { session_id: 'session-C' }).status, 0);
});

test('a session that declared the role director is never blocked by a run and cannot start one', () => {
  const root = project(['ORD-0001', 'ORD-0002']);
  assert.equal(aos(root, ['role', 'declare', 'director', '--scope', '.analucia/drafts/**'], 'session-D').status, 0);
  // It cannot start a run: nothing is written.
  const before = log(root);
  const refused = aos(root, ['run', 'start', 'ORD-0001'], 'session-D');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /aos run start: E_DIRECTOR_RUN /);
  assert.match(refused.stderr, /next \(director\)/);
  assert.equal(log(root), before);
  // A run with no recorded owner blocks everyone but the director session.
  assert.equal(aos(root, ['run', 'start', 'ORD-0001']).status, 0);
  assert.equal(stop(root, { session_id: 'session-X' }).status, 2);
  const director = stop(root, { session_id: 'session-D' });
  assert.equal(director.status, 0, director.stderr);
  assert.match(director.stdout, /run 1 of ORD-0001 is open/);
  // A run owned by another session does not block it either.
  assert.equal(aos(root, ['run', 'start', 'ORD-0002'], 'session-A').status, 0);
  assert.equal(stop(root, { session_id: 'session-D' }).status, 0);
  assert.equal(stop(root, { session_id: 'session-A' }).status, 2);
});

test('the SessionStart hook no longer declares executor for a session that declared director under the same id', () => {
  const root = project([]);
  const roles = () => readLog(root).events.filter((e) => e.type === 'role.declared').map((e) => `${e.actor}:${e.agent?.session}`);
  assert.equal(hookStart(root, 'session-D').status, 0);
  assert.deepEqual(roles(), ['executor:session-D'], 'a new session is an executor until it says otherwise');
  assert.equal(aos(root, ['role', 'declare', 'director', '--scope', '.analucia/drafts/**'], 'session-D').status, 0);
  // Resumed, compacted or cleared: the hook runs again and must not turn it back into an executor.
  for (const source of ['resume', 'compact', 'clear']) assert.equal(hookStart(root, 'session-D', source).status, 0);
  assert.deepEqual(roles(), ['executor:session-D', 'director:session-D']);
  // Another session is still declared executor, and the director session is still recorded as a session.
  assert.equal(hookStart(root, 'session-E').status, 0);
  assert.deepEqual(roles(), ['executor:session-D', 'director:session-D', 'executor:session-E']);
  assert.equal(readLog(root).events.filter((e) => e.type === 'session.start' && e.payload.session === 'session-D').length, 4);
  assert.equal(stop(root, { session_id: 'session-D' }).status, 0);
});

test('a broken log blocks every session, the director session too', () => {
  const root = project();
  assert.equal(aos(root, ['role', 'declare', 'director', '--scope', '.analucia/drafts/**'], 'session-D').status, 0);
  writeFileSync(logPath(root), log(root).replace('"director"', '"Director"'));
  for (const input of [undefined, { session_id: 'session-D' }, { session_id: 'session-B' }]) {
    const r = stop(root, input);
    assert.equal(r.status, 2, JSON.stringify(input));
    assert.match(r.stderr, /the event log is broken/);
  }
});
