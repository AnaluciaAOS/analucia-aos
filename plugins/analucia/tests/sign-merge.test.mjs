// ORD-0041 part 7 (AMD-0015 §7): FIRMAR offers the step to main. When `aos sign` closed at least one order on a branch
// that is not the default branch and everything it committed is pushed, it shows the branch, the number of commits
// and that it will be a fast-forward, and asks for a typed word. On that word it switches to the default branch,
// merges fast-forward only and pushes, then says where the project stands. If a fast-forward is not possible, or
// anything fails, it changes nothing further and says so in one line. Never a force, never a merge commit, never
// without the typed word, never from an agent. Scratch repositories with a local bare remote.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hashLF } from '../lib/lock.mjs';
import { appendEvent, logPath, readLog } from '../lib/log.mjs';
import { sign } from '../lib/sign.mjs';
import { replay } from '../lib/state.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
delete env.CLAUDE_PROJECT_DIR;
delete env.CLAUDE_CODE_SESSION_ID;
const aos = (root, args) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input: '', env });
const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' });
const rev = (cwd, ref) => git(cwd, 'rev-parse', ref).stdout.trim();
const branch = (cwd) => git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();

// A project on main with a bare remote, then a work branch (pushed) with one delivered order on it.
function delivered({ remote = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aos-merge-'));
  const a = join(root, '.analucia');
  for (const d of ['orders', 'verify', 'evidence']) mkdirSync(join(a, d), { recursive: true });
  writeFileSync(join(a, 'project.json'), '{"wip_limit":2,"locale":"en"}\n');
  writeFileSync(logPath(root), '');
  writeFileSync(join(a, 'evidence', 'report.md'), '# r\n\n## Evidencia\n\nx\n\nOUTCOME: done\n');
  const id = 'ORD-0001';
  writeFileSync(join(a, 'orders', `${id}.md`), ['---', `id: ${id}`, 'title: T', 'kind: fix', 'created: 2026-11-14', 'budget_max_minutes: 30', 'budget_max_attempts: 2', '---', '', '## Acceptance criteria', '', '- [ ] x', ''].join('\n'));
  writeFileSync(join(a, 'verify', `${id}.json`), JSON.stringify({ order: id, checks: [{ name: 'c', run: 'exit 0', expect_exit: 0 }] }));
  const files = {};
  for (const rel of [`.analucia/orders/${id}.md`, `.analucia/verify/${id}.json`]) files[rel] = hashLF(readFileSync(join(root, rel)));
  writeFileSync(join(a, 'director.lock'), JSON.stringify({ files }));
  appendEvent(root, { type: 'record.created', actor: 'director', subject: id });
  appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: id, payload: { from: 'draft', to: 'ready' } });
  appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: id, payload: { from: 'ready', to: 'queued' } });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 't');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  let bare = null;
  if (remote) {
    bare = mkdtempSync(join(tmpdir(), 'aos-merge-bare-'));
    git(bare, 'init', '-q', '--bare', '-b', 'main');
    git(root, 'remote', 'add', 'origin', bare);
    git(root, 'push', '-q', '-u', 'origin', 'main');
  }
  git(root, 'switch', '-q', '-c', 'work');
  assert.equal(aos(root, ['run', 'start', id]).status, 0);
  writeFileSync(join(root, 'work.txt'), 'done\n');
  git(root, 'add', 'work.txt');
  git(root, 'commit', '-q', '-m', `work\n\nAnalucia-Order: ${id}`);
  assert.equal(aos(root, ['run', 'finish', id, '--outcome', 'done', '--evidence', '.analucia/evidence/report.md']).status, 0);
  if (remote) git(root, 'push', '-q', '-u', 'origin', 'work');
  return { root, bare, id };
}
const owner = (answers, extra = {}) => {
  const lines = [];
  const prompts = [];
  return { isTTY: true, lines, prompts, out: (s) => lines.push(s), ask: async (q) => { prompts.push(q); return answers.length ? answers.shift() : ''; }, ...extra };
};
const stateOf = (root, id) => replay(readLog(root).events).orders[id].state;

test('after signing on a branch, the typed word takes it to main: fast-forward only, pushed, no merge commit', async () => {
  const { root, bare, id } = delivered();
  const mainBefore = rev(root, 'main');
  const o = owner(['CLOSE', 'MERGE']);
  const r = await sign(root, o);
  assert.deepEqual(r.signed, [id]);
  assert.equal(r.pushed, true);
  // The offer: the branch, the number of commits, a fast-forward, and a typed word.
  assert.equal(o.prompts.length, 2);
  assert.match(o.prompts[1], /branch work/);
  assert.match(o.prompts[1], /2 commit\(s\)/);
  assert.match(o.prompts[1], /fast-forward/);
  assert.match(o.prompts[1], /Type MERGE/);
  // Done: on main, main is the signed commit, the remote too, and no merge commit anywhere.
  assert.deepEqual(r.merged, { offered: true, done: true, branch: 'work', into: 'main', commits: 2 });
  assert.equal(branch(root), 'main');
  assert.notEqual(rev(root, 'main'), mainBefore);
  assert.equal(rev(root, 'main'), rev(root, 'work'));
  assert.equal(rev(bare, 'main'), rev(root, 'work'));
  assert.equal(git(root, 'rev-list', '--count', '--merges', 'main').stdout.trim(), '0');
  assert.match(o.lines.join('\n'), /main now holds the signed work \([0-9a-f]{7,}\) and it is sent/);
  assert.equal(stateOf(root, id), 'closed');
});

test('without the typed word nothing moves: the branch, main and the remote stay as they were', async () => {
  for (const typed of ['', 'yes', 'merge', 'CLOSE']) {
    const { root, bare, id } = delivered();
    const mainBefore = rev(root, 'main');
    const o = owner(['CLOSE', typed]);
    const r = await sign(root, o);
    assert.deepEqual(r.signed, [id], typed);
    assert.deepEqual(r.merged, { offered: true, done: false, branch: 'work', into: 'main', commits: 2 }, typed);
    assert.equal(branch(root), 'work', typed);
    assert.equal(rev(root, 'main'), mainBefore, typed);
    assert.equal(rev(bare, 'main'), mainBefore, typed);
    assert.match(o.lines.join('\n'), /main was not touched/, typed);
  }
});

test('when a fast-forward is not possible it changes nothing and says so in one line; no word is asked', async () => {
  const { root, bare, id } = delivered();
  // main moved on its own: the branch no longer contains it.
  git(root, 'switch', '-q', 'main');
  writeFileSync(join(root, 'other.txt'), 'x\n');
  git(root, 'add', 'other.txt');
  git(root, 'commit', '-q', '-m', 'another change on main');
  git(root, 'push', '-q', 'origin', 'main');
  git(root, 'switch', '-q', 'work');
  const mainBefore = rev(root, 'main');
  const o = owner(['CLOSE', 'MERGE']);
  const r = await sign(root, o);
  assert.deepEqual(r.signed, [id]);
  assert.equal(o.prompts.length, 1, 'only the signature was asked');
  assert.equal(r.merged.done, false);
  assert.equal(o.lines.filter((l) => /fast-forward is not possible/.test(l)).length, 1);
  assert.equal(branch(root), 'work');
  assert.equal(rev(root, 'main'), mainBefore);
  assert.equal(rev(bare, 'main'), mainBefore);
  assert.equal(git(root, 'rev-list', '--count', '--merges', '--all').stdout.trim(), '0');
});

test('it is not offered on the default branch, when nothing was closed, or when the sign-off was not pushed', async () => {
  // Signing on main itself.
  const onMain = delivered();
  git(onMain.root, 'switch', '-q', 'main');
  git(onMain.root, 'merge', '-q', '--ff-only', 'work');
  const a = owner(['CLOSE', 'MERGE']);
  const ra = await sign(onMain.root, a);
  assert.deepEqual(ra.signed, [onMain.id]);
  assert.equal(a.prompts.length, 1);
  assert.equal(ra.merged, undefined);
  // The owner did not type CLOSE: nothing closed, nothing offered.
  const refused = delivered();
  const b = owner(['no', 'MERGE']);
  await assert.rejects(sign(refused.root, b), (x) => x.code === 'E_NOT_CONFIRMED');
  assert.equal(b.prompts.length, 1);
  assert.equal(branch(refused.root), 'work');
  // The sign-off could not be pushed (no remote): the step is not offered.
  const local = delivered({ remote: false });
  const c = owner(['CLOSE', 'MERGE']);
  const rc = await sign(local.root, c);
  assert.deepEqual(rc.signed, [local.id]);
  assert.equal(rc.pushed, false);
  assert.equal(c.prompts.length, 1);
  assert.equal(branch(local.root), 'work');
  // Never from an agent.
  const agent = delivered();
  const r = aos(agent.root, ['sign']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /E_OWNER_TTY/);
  assert.equal(branch(agent.root), 'work');
});

test('if the switch fails nothing further changes, and one line says so', async () => {
  const { root, bare, id } = delivered();
  // work.txt exists on the branch only; with an uncommitted edit of it, git refuses to leave the branch.
  writeFileSync(join(root, 'work.txt'), 'edited and not committed\n');
  const mainBefore = rev(root, 'main');
  const o = owner(['CLOSE', 'MERGE']);
  const r = await sign(root, o);
  assert.deepEqual(r.signed, [id]);
  assert.equal(r.merged.done, false);
  assert.equal(branch(root), 'work');
  assert.equal(rev(root, 'main'), mainBefore);
  assert.equal(rev(bare, 'main'), mainBefore);
  assert.equal(o.lines.filter((l) => /The step to main was not made/.test(l)).length, 1);
  assert.equal(readFileSync(join(root, 'work.txt'), 'utf8'), 'edited and not committed\n', 'the uncommitted edit is untouched');
});
