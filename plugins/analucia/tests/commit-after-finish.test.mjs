// ORD-0041 part 8 (AMD-0015 §6): no commits after `run finish`. The push guard refuses a commit that carries the
// trailer of an order and is dated after the last run.finished of that order while no run of it is open. The
// owner's sign-off commit and commits that touch only owner and director paths are not affected.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { blockTemplate } from '../lib/guards.mjs';
import { appendEvent, logPath } from '../lib/log.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
delete env.CLAUDE_PROJECT_DIR;
delete env.CLAUDE_CODE_SESSION_ID;
const GOOD_URL = 'https://example@github.com/example/demo.git';
const push = (root) => spawnSync(process.execPath, [AOS, 'check-push', 'origin', GOOD_URL, '--root', root], { encoding: 'utf8', input: '', env });
const git = (cwd, args, date) => spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8', env: date ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : process.env });

const T0 = new Date('2026-11-14T10:00:00-05:00'); // the run starts
const FINISH = new Date('2026-11-14T12:00:00-05:00'); // the run is finished
const BEFORE = '2026-11-14T11:00:00-05:00';
const AFTER = '2026-11-14T12:30:00-05:00';

// A repo whose origin has the first commit; ORD-0001 has run 1 open since T0.
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'aos-after-'));
  const bare = mkdtempSync(join(tmpdir(), 'aos-after-bare-'));
  git(bare, ['init', '-q', '--bare']);
  git(root, ['init', '-q', '-b', 'main']);
  mkdirSync(join(root, '.analucia', 'evidence'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, '.analucia', 'project.json'), '{"wip_limit":2,"github_owner":"example"}\n');
  writeFileSync(logPath(root), '');
  const at = { now: T0 };
  appendEvent(root, { type: 'record.created', actor: 'director', subject: 'ORD-0001' }, at);
  appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: 'ORD-0001', payload: { from: 'draft', to: 'ready' } }, at);
  appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: 'ORD-0001', payload: { from: 'ready', to: 'queued' } }, at);
  startRun(root, 1, T0);
  writeFileSync(join(root, 'src', 'tool.js'), 'export const x = 1;\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'base'], '2026-11-14T09:00:00-05:00');
  git(root, ['remote', 'add', 'origin', bare]);
  git(root, ['push', '-q', '--no-verify', 'origin', 'main']);
  git(root, ['fetch', '-q', 'origin']);
  git(root, ['config', 'credential.https://github.com.username', 'example']);
  return root;
}
function startRun(root, run, now) {
  appendEvent(root, { type: 'order.state_changed', actor: 'executor', subject: 'ORD-0001', payload: { from: run === 1 ? 'queued' : 'queued', to: 'active' } }, { now });
  appendEvent(root, { type: 'run.started', actor: 'executor', subject: 'ORD-0001', payload: { run } }, { now });
}
function finishRun(root, run, now) {
  appendEvent(root, { type: 'run.finished', actor: 'executor', subject: 'ORD-0001', payload: { run, outcome: 'budget_exhausted' } }, { now });
  appendEvent(root, { type: 'order.state_changed', actor: 'executor', subject: 'ORD-0001', payload: { from: 'active', to: 'queued', reason: 'more to do' } }, { now });
}
const commit = (root, files, message, date) => {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  git(root, ['add', '-A']);
  assert.equal(git(root, ['commit', '-q', '-m', message], date).status, 0);
};

test('a commit of the order dated after its run was finished is refused; the same commit made before passes', () => {
  const root = repo();
  commit(root, { 'src/tool.js': 'export const x = 2;\n' }, 'work in the run\n\nAnalucia-Order: ORD-0001', BEFORE);
  finishRun(root, 1, FINISH);
  const ok = push(root);
  assert.equal(ok.status, 0, ok.stderr);
  // One more commit after `run finish`: work outside any open run.
  commit(root, { 'src/tool.js': 'export const x = 3;\n' }, 'one more thing\n\nAnalucia-Order: ORD-0001', AFTER);
  const r = push(root);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /aos check-push: E_COMMIT_AFTER_FINISH push refused: 1 commit\(s\) .* were made after the run of their order was finished/);
  assert.match(r.stderr, /next \(executor\)/);
  assert.match(r.stderr, /- [0-9a-f]{7} carries the trailer of ORD-0001 and is dated after its last run\.finished \(2026-11-14T12:00:00/);
});

test('while a run of the order is open, a commit dated after an earlier run.finished is its own work and passes', () => {
  const root = repo();
  finishRun(root, 1, FINISH);
  startRun(root, 2, new Date('2026-11-14T12:15:00-05:00'));
  commit(root, { 'src/tool.js': 'export const x = 4;\n' }, 'work of run 2\n\nAnalucia-Order: ORD-0001', AFTER);
  const ok = push(root);
  assert.equal(ok.status, 0, ok.stderr);
  // Run 2 finished later than the commit: still fine.
  finishRun(root, 2, new Date('2026-11-14T13:00:00-05:00'));
  assert.equal(push(root).status, 0);
});

test('the owner sign-off commit and commits that touch only owner and director paths are not affected', () => {
  const root = repo();
  commit(root, { 'src/tool.js': 'export const x = 2;\n' }, 'work in the run\n\nAnalucia-Order: ORD-0001', BEFORE);
  finishRun(root, 1, FINISH);
  // The sign-off: the log and the evidence, with the trailer of the order, dated after the finish.
  commit(root, { '.analucia/evidence/ORD-0001/verify-01.txt': 'all checks passed\n' }, 'Sign-off: close ORD-0001 (owner, aos sign)\n\nAnalucia-Order: ORD-0001', AFTER);
  // A director placement, no trailer, after the finish.
  commit(root, { '.analucia/orders/ORD-0002.md': 'x\n', '.analucia/director.lock': '{}\n' }, 'Director: ORD-0002 placed', AFTER);
  const ok = push(root);
  assert.equal(ok.status, 0, ok.stderr);
  // An order that never finished a run is not judged; a commit without a trailer keeps its own error.
  commit(root, { 'src/other.js': 'x\n' }, 'no trailer', AFTER);
  assert.match(push(root).stderr, /E_NO_ORDER_TRAILER/);
});

test('the rules block says it: after run finish you commit nothing', () => {
  const line = blockTemplate().split('\n').find((l) => /After `?aos run finish`?|After `run finish`/.test(l));
  assert.ok(line, 'one line in the rules block');
  assert.match(line, /commit nothing/);
  assert.match(line, /report/);
  assert.match(line, /pending/);
});
