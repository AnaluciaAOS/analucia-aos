// ORD-0043 part 1 (OBS-164): a compaction is never blocked. `aos check-writeback` exits 0 on the `PreCompact` event
// whatever is open: compacting does not end a run. With a run open in that session it says, in one line, which order
// has a run open and that the handoff was written (`.analucia/views/handoff-<ID>.md`). A broken log only warns before
// a compaction. The `Stop` event keeps the behaviour of ORD-0041 part 5.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { appendEvent, logPath } from '../lib/log.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const baseEnv = { ...process.env };
delete baseEnv.CLAUDE_PROJECT_DIR;
delete baseEnv.CLAUDE_CODE_SESSION_ID;
const aos = (root, args, session) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input: '', env: session ? { ...baseEnv, CLAUDE_CODE_SESSION_ID: session } : baseEnv });
const hook = (root, input) => spawnSync(process.execPath, [AOS, 'check-writeback'], { encoding: 'utf8', cwd: root, env: { ...baseEnv, CLAUDE_PROJECT_DIR: root }, input: input === undefined ? '' : JSON.stringify(input) });
const ORDER = (id) => ['---', `id: ${id}`, 'title: T', 'kind: fix', 'created: 2026-11-16', 'budget_max_minutes: 30', 'budget_max_attempts: 3', '---', '', '## Acceptance criteria', '', '- [ ] x', ''].join('\n');
const handoff = (root, id = 'ORD-0001') => join(root, '.analucia', 'views', `handoff-${id}.md`);

function project() {
  const root = mkdtempSync(join(tmpdir(), 'aos-compact-'));
  mkdirSync(join(root, '.analucia', 'orders'), { recursive: true });
  writeFileSync(join(root, '.analucia', 'project.json'), '{"wip_limit":3,"locale":"en"}\n');
  writeFileSync(logPath(root), '');
  writeFileSync(join(root, '.analucia', 'orders', 'ORD-0001.md'), ORDER('ORD-0001'));
  appendEvent(root, { type: 'record.created', actor: 'director', subject: 'ORD-0001' });
  appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: 'ORD-0001', payload: { from: 'draft', to: 'ready' } });
  appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: 'ORD-0001', payload: { from: 'ready', to: 'queued' } });
  return root;
}

test('an open run owned by the session: PreCompact exits 0 with one line and writes the handoff; Stop is still blocked', () => {
  const root = project();
  assert.equal(aos(root, ['run', 'start', 'ORD-0001'], 'session-A').status, 0);
  const compact = hook(root, { session_id: 'session-A', hook_event_name: 'PreCompact', trigger: 'manual' });
  assert.equal(compact.status, 0, compact.stderr);
  assert.equal(compact.stderr, '');
  const lines = compact.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 1, compact.stdout);
  assert.match(lines[0], /^Analucia: run 1 of ORD-0001 is open in this session; compacting does not end it\. The handoff was written: \.analucia\/views\/handoff-ORD-0001\.md/);
  assert.ok(existsSync(handoff(root)));
  const text = readFileSync(handoff(root), 'utf8');
  assert.match(text, /^# Handoff of ORD-0001/);
  assert.match(text, /run 1 of 3/);
  // The end of the session keeps the rule of ORD-0041 part 5.
  const stop = hook(root, { session_id: 'session-A', hook_event_name: 'Stop' });
  assert.equal(stop.status, 2);
  assert.match(stop.stderr, /run 1 of ORD-0001 is still open/);
});

test('another session, and no run at all: PreCompact exits 0; the other session is told as before and writes no handoff', () => {
  const root = project();
  const quiet = hook(root, { session_id: 'session-A', hook_event_name: 'PreCompact' });
  assert.deepEqual([quiet.status, quiet.stdout, quiet.stderr], [0, '', '']);
  assert.equal(aos(root, ['run', 'start', 'ORD-0001'], 'session-A').status, 0);
  const other = hook(root, { session_id: 'session-B', hook_event_name: 'PreCompact' });
  assert.equal(other.status, 0, other.stderr);
  assert.match(other.stdout, /run 1 of ORD-0001 is open in another session \(session-A\)/);
  assert.equal(existsSync(handoff(root)), false);
});

test('no session in the hook input: PreCompact still exits 0 with its line; Stop blocks every session as before', () => {
  const root = project();
  assert.equal(aos(root, ['run', 'start', 'ORD-0001'], 'session-A').status, 0);
  for (const input of [{ hook_event_name: 'PreCompact' }, { hook_event_name: 'PreCompact', session_id: '' }]) {
    const r = hook(root, input);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /run 1 of ORD-0001 is open/);
    assert.match(r.stdout, /compacting does not end it/);
  }
  assert.equal(hook(root, { hook_event_name: 'Stop' }).status, 2);
  assert.equal(hook(root).status, 2, 'no hook input at all is not a compaction');
});

test('a broken log only warns before a compaction; it still blocks the end of a session', () => {
  const root = project();
  writeFileSync(logPath(root), readFileSync(logPath(root), 'utf8').replace('"director"', '"Director"'));
  const compact = hook(root, { session_id: 'session-A', hook_event_name: 'PreCompact' });
  assert.equal(compact.status, 0, compact.stderr);
  assert.match(compact.stdout, /the event log is broken/);
  assert.match(compact.stdout, /compacting is not blocked/);
  const stop = hook(root, { session_id: 'session-A', hook_event_name: 'Stop' });
  assert.equal(stop.status, 2);
  assert.match(stop.stderr, /the event log is broken/);
});
