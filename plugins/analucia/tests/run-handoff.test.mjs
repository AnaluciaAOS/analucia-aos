// ORD-0043 part 5 (OBS-163): a run does not depend on one session. `aos run handoff <ID> --next "…"` writes the
// handoff on disk (`.analucia/views/handoff-<ID>.md`, generated, never committed); `resume.md` carries it while the
// run is open. `aos run take <ID>` makes the calling session the owner of the open run, recorded as
// `operation.logged`: no new run, no attempt consumed; the former owner is no longer blocked by the stop hook. A
// session declared director cannot take a run. `aos next` tells an executor session that is not the owner to take
// the run and to read the handoff first.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AOS_BIN } from '../lib/cli.mjs';
import { blockTemplate } from '../lib/guards.mjs';
import { appendEvent, logPath, readLog } from '../lib/log.mjs';
import { replay } from '../lib/state.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const baseEnv = { ...process.env };
delete baseEnv.CLAUDE_PROJECT_DIR;
delete baseEnv.CLAUDE_CODE_SESSION_ID;
const aos = (root, args, session) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input: '', env: session ? { ...baseEnv, CLAUDE_CODE_SESSION_ID: session } : baseEnv });
const stop = (root, session, event = 'Stop') => spawnSync(process.execPath, [AOS, 'check-writeback'], { encoding: 'utf8', cwd: root, env: { ...baseEnv, CLAUDE_PROJECT_DIR: root }, input: JSON.stringify({ session_id: session, hook_event_name: event }) });
const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' });
const HANDOFF = '.analucia/views/handoff-ORD-0001.md';
const CMD = `node "${AOS_BIN}"`;

// One order with run 1 open, started by session-A, in a git repository with one commit of the order.
function running() {
  const root = mkdtempSync(join(tmpdir(), 'aos-handoff-'));
  const a = join(root, '.analucia');
  for (const d of ['orders', 'evidence']) mkdirSync(join(a, d), { recursive: true });
  writeFileSync(join(a, 'project.json'), '{"wip_limit":1,"locale":"en"}\n');
  writeFileSync(join(root, '.gitignore'), '.analucia/views/\n');
  writeFileSync(logPath(root), '');
  writeFileSync(join(a, 'evidence', 'report.md'), '# r\n\n## Evidencia\n\nx\n\nWork: not complete\nOUTCOME: budget_exhausted\n');
  writeFileSync(join(a, 'orders', 'ORD-0001.md'), ['---', 'id: ORD-0001', 'title: T', 'kind: fix', 'created: 2026-11-16', 'budget_max_minutes: 30', 'budget_max_attempts: 3', '---', '', '## Acceptance criteria', '', '- [ ] x', ''].join('\n'));
  appendEvent(root, { type: 'record.created', actor: 'director', subject: 'ORD-0001' });
  appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: 'ORD-0001', payload: { from: 'draft', to: 'ready' } });
  appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: 'ORD-0001', payload: { from: 'ready', to: 'queued' } });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  assert.equal(aos(root, ['run', 'start', 'ORD-0001'], 'session-A').status, 0);
  writeFileSync(join(root, 'part1.txt'), 'done\n');
  git(root, 'add', 'part1.txt');
  git(root, 'commit', '-q', '-m', 'part 1 of the order', '-m', 'Analucia-Order: ORD-0001');
  writeFileSync(join(root, 'part2.txt'), 'half\n');
  return root;
}
const runs = (root) => readLog(root).events.filter((e) => e.type === 'run.started').length;

test('aos run handoff writes the handoff on disk: the run, the minutes, the last commit, what is not committed, and what comes next', () => {
  const root = running();
  assert.equal(aos(root, ['run', 'handoff', 'ORD-0001'], 'session-A').status, 2, '--next is required');
  const before = readFileSync(logPath(root), 'utf8');
  const r = aos(root, ['run', 'handoff', 'ORD-0001', '--next', 'part 2: finish the second file, then its test'], 'session-A');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\.analucia\/views\/handoff-ORD-0001\.md/);
  const text = readFileSync(join(root, HANDOFF), 'utf8');
  assert.match(text, /^# Handoff of ORD-0001/);
  assert.match(text, /^- Run: run 1 of 3, open since .*owned by the session session-A$/m);
  assert.match(text, /^- Minutes: \d+ used, \d+ left$/m);
  assert.match(text, /^- Last commit of the order: [0-9a-f]{7,} part 1 of the order$/m);
  assert.match(text, /^- Changed and not committed: 2 file\(s\)$/m);
  assert.match(text, /^ {2}- part2\.txt$/m);
  assert.doesNotMatch(text, /half/, 'names only, never content');
  assert.match(text, /^- Next: part 2: finish the second file, then its test$/m);
  // Generated, never committed: it is not in the log and git ignores it.
  assert.equal(readFileSync(logPath(root), 'utf8'), before);
  assert.equal(git(root, 'status', '--porcelain', '--', HANDOFF).stdout, '');
  // The hook of a compaction keeps the "next" a session wrote for the same run.
  assert.equal(stop(root, 'session-A', 'PreCompact').status, 0);
  assert.match(readFileSync(join(root, HANDOFF), 'utf8'), /^- Next: part 2: finish the second file, then its test$/m);
  // resume.md carries it while the run is open, and no longer once the run is finished.
  assert.equal(aos(root, ['derive']).status, 0);
  const resume = () => readFileSync(join(root, '.analucia', 'views', 'resume.md'), 'utf8');
  assert.match(resume(), /## Handoff of the open run/);
  assert.match(resume(), /ORD-0001.*handoff-ORD-0001\.md.*part 2: finish the second file/);
  assert.equal(aos(root, ['run', 'finish', 'ORD-0001', '--outcome', 'budget_exhausted', '--evidence', '.analucia/evidence/report.md'], 'session-A').status, 0);
  assert.equal(aos(root, ['derive']).status, 0);
  assert.doesNotMatch(resume(), /## Handoff of the open run/);
  assert.equal(existsSync(join(root, HANDOFF)), false, 'the handoff of a finished run is removed');
  // With no open run it refuses.
  assert.equal(aos(root, ['run', 'handoff', 'ORD-0001', '--next', 'x'], 'session-A').status, 1);
});

test('aos run take: another session becomes the owner of the open run; no new run, no attempt; the former owner is free', () => {
  const root = running();
  assert.equal(stop(root, 'session-A').status, 2);
  assert.equal(stop(root, 'session-B').status, 0);
  const r = aos(root, ['run', 'take', 'ORD-0001'], 'session-B');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ORD-0001: run 1 is now owned by this session \(session-B\); it was owned by session-A/);
  const taken = readLog(root).events.at(-1);
  assert.deepEqual([taken.type, taken.actor, taken.subject], ['operation.logged', 'executor', 'ORD-0001']);
  assert.deepEqual(taken.payload, { operation: 'run.take', run: 1, session: 'session-B', from: 'session-A' });
  assert.equal(taken.agent.session, 'session-B');
  assert.equal(runs(root), 1, 'no new run, no attempt consumed');
  assert.equal(replay(readLog(root).events).orders['ORD-0001'].state, 'active');
  // The stop hook follows the owner.
  assert.equal(stop(root, 'session-A').status, 0, 'the former owner is no longer blocked');
  assert.match(stop(root, 'session-A').stdout, /open in another session \(session-B\)/);
  assert.equal(stop(root, 'session-B').status, 2);
  // The new owner finishes the run it took.
  assert.equal(aos(root, ['run', 'finish', 'ORD-0001', '--outcome', 'budget_exhausted', '--evidence', '.analucia/evidence/report.md'], 'session-B').status, 0);
  assert.equal(stop(root, 'session-B').status, 0);
});

test('aos run take refuses a director session, a call with no session, and an order with no open run', () => {
  const root = running();
  assert.equal(aos(root, ['role', 'declare', 'director', '--scope', '.analucia/drafts/**'], 'session-D').status, 0);
  const before = readFileSync(logPath(root), 'utf8');
  const director = aos(root, ['run', 'take', 'ORD-0001'], 'session-D');
  assert.equal(director.status, 1);
  assert.match(director.stderr, /E_DIRECTOR_RUN/);
  const nobody = aos(root, ['run', 'take', 'ORD-0001']);
  assert.equal(nobody.status, 1);
  assert.match(nobody.stderr, /E_MISSING_FIELD .*session/);
  assert.equal(readFileSync(logPath(root), 'utf8'), before);
  // The owner taking its own run changes nothing.
  const own = aos(root, ['run', 'take', 'ORD-0001'], 'session-A');
  assert.equal(own.status, 0);
  assert.match(own.stdout, /already owned by this session/);
  assert.equal(readFileSync(logPath(root), 'utf8'), before);
  assert.equal(aos(root, ['run', 'finish', 'ORD-0001', '--outcome', 'budget_exhausted', '--evidence', '.analucia/evidence/report.md'], 'session-A').status, 0);
  const none = aos(root, ['run', 'take', 'ORD-0001'], 'session-B');
  assert.equal(none.status, 1);
  assert.match(none.stderr, /E_TRANSITION ORD-0001 has no open run/);
  assert.match(none.stderr, /Next \(executor\): start ORD-0001/);
});

test('aos next: the owner of the run is told to finish it; another executor session is told to take it and read the handoff first', () => {
  const root = running();
  const next = (session) => aos(root, ['next'], session).stdout.trimEnd();
  assert.match(next('session-A'), /^Next \(executor\): run 1 of ORD-0001 is open\. Finish the work/);
  assert.match(next(undefined), /^Next \(executor\): run 1 of ORD-0001 is open\. Finish the work/, 'with no session known, as before');
  assert.equal(next('session-B'), `Next (executor): run 1 of ORD-0001 is open in another session (session-A). Read the handoff .analucia/views/handoff-ORD-0001.md first, then take the run with: ${CMD} run take ORD-0001`);
  assert.equal(aos(root, ['run', 'take', 'ORD-0001'], 'session-B').status, 0);
  assert.match(next('session-B'), /is open\. Finish the work/);
  assert.match(next('session-A'), /open in another session \(session-B\)/);
});

test('the rules block says it: commit at the end of each part, write the handoff, a new session takes the run', () => {
  const line = blockTemplate().split('\n').find((l) => /aos run take/.test(l));
  assert.ok(line);
  assert.match(line, /commit at the end of each part/i);
  assert.match(line, /aos run handoff/);
  assert.match(line, /never starts another/);
});
