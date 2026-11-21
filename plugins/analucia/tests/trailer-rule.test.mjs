// ORD-0043 part 12 (OBS-168): one trailer rule. `aos trailer check <ID> --from <commit>` judges the commits of an
// order with the same function the push guard calls: a commit that changes code carries the trailer of the order; a
// commit that touches only the log, the evidence or the director paths needs none. Every preflight includes the
// built-in check "push guard installed": the pre-push hook exists where git looks for it (core.hooksPath honoured),
// it calls `aos check-push`, and the path it uses to find the plugin carries no version number.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { installGitHooks, pushGuardStatus, trailerCheck, trailerProblems } from '../lib/guards.mjs';
import { findBash } from '../lib/lifecycle.mjs';
import { hashLF } from '../lib/lock.mjs';
import { appendEvent, logPath } from '../lib/log.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
delete env.CLAUDE_PROJECT_DIR;
delete env.CLAUDE_CODE_SESSION_ID;
const GOOD_URL = 'https://example@github.com/example/demo.git';
const aos = (root, args) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input: '', env });
const push = (root) => aos(root, ['check-push', 'origin', GOOD_URL]);
const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' });
const head = (root) => git(root, 'rev-parse', 'HEAD').stdout.trim();

// A repo whose origin has the first commit; ORD-0001 is placed and has run 1 open.
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'aos-trailer-'));
  const bare = mkdtempSync(join(tmpdir(), 'aos-trailer-bare-'));
  git(bare, 'init', '-q', '--bare');
  git(root, 'init', '-q', '-b', 'main');
  for (const d of ['orders', 'verify', 'evidence/ORD-0001']) mkdirSync(join(root, '.analucia', d), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, '.analucia', 'project.json'), '{"wip_limit":2,"locale":"en","github_owner":"example"}\n');
  writeFileSync(join(root, '.analucia', 'orders', 'ORD-0001.md'), ['---', 'id: ORD-0001', 'title: T', 'kind: fix', 'created: 2026-11-16', 'budget_max_minutes: 30', 'budget_max_attempts: 3', 'risk: low', 'cost_effect: none', '---', '', '## Acceptance criteria', '', '- [ ] x', ''].join('\n'));
  writeFileSync(join(root, '.analucia', 'verify', 'ORD-0001.json'), JSON.stringify({ order: 'ORD-0001', checks: [{ name: 'c', run: 'exit 0', expect_exit: 0 }] }));
  const files = {};
  for (const rel of ['.analucia/orders/ORD-0001.md', '.analucia/verify/ORD-0001.json']) files[rel] = hashLF(readFileSync(join(root, rel)));
  writeFileSync(join(root, '.analucia', 'director.lock'), JSON.stringify({ files }));
  writeFileSync(logPath(root), '');
  appendEvent(root, { type: 'record.created', actor: 'director', subject: 'ORD-0001' });
  appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: 'ORD-0001', payload: { from: 'draft', to: 'ready' } });
  appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: 'ORD-0001', payload: { from: 'ready', to: 'queued' } });
  writeFileSync(join(root, 'src', 'tool.js'), 'export const x = 1;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  git(root, 'remote', 'add', 'origin', bare);
  git(root, 'push', '-q', '--no-verify', 'origin', 'main');
  git(root, 'fetch', '-q', 'origin');
  git(root, 'remote', 'set-url', 'origin', GOOD_URL);
  git(root, 'config', 'credential.https://github.com.username', 'example');
  return root;
}
const startRun = (root) => {
  appendEvent(root, { type: 'order.state_changed', actor: 'executor', subject: 'ORD-0001', payload: { from: 'queued', to: 'active' } });
  appendEvent(root, { type: 'run.started', actor: 'executor', subject: 'ORD-0001', payload: { run: 1 } });
};
const commit = (root, files, message) => {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  git(root, 'add', '-A');
  assert.equal(git(root, 'commit', '-q', '-m', message).status, 0);
  return head(root);
};

test('a report-only commit without the trailer passes both the guard and the check; a code commit without it fails both', () => {
  const root = repo();
  startRun(root);
  const base = head(root);
  commit(root, { 'src/tool.js': 'export const x = 2;\n' }, 'work\n\nAnalucia-Order: ORD-0001');
  const report = commit(root, { '.analucia/evidence/ORD-0001/report.md': '# r\n\nOUTCOME: done\n' }, 'the report, with no trailer');
  // Both pass: the report-only commit needs no trailer.
  const guard = push(root);
  assert.equal(guard.status, 0, guard.stderr);
  const check = aos(root, ['trailer', 'check', 'ORD-0001', '--from', base]);
  assert.equal(check.status, 0, check.stderr + check.stdout);
  // The range ends at the newest commit of the order: the report-only commit after it is not even looked at.
  assert.match(check.stdout, /1 commit\(s\).*1 change code.*trailer of ORD-0001/);
  assert.deepEqual(trailerCheck(root, 'ORD-0001', { from: base }).problems, []);
  // One function: the guard's list of failures is the list of trailerProblems.
  assert.deepEqual(trailerProblems(root, [report], { started: new Set(['ORD-0001']) }).trailers, []);

  // A code commit without the trailer, then one more commit of the order after it: both the guard and the check fail.
  const bad = commit(root, { 'src/tool.js': 'export const x = 3;\n' }, 'code with no trailer');
  commit(root, { 'src/other.js': 'export const y = 1;\n' }, 'more work\n\nAnalucia-Order: ORD-0001');
  const refused = push(root);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /E_NO_ORDER_TRAILER/);
  assert.match(refused.stderr, new RegExp(`${bad.slice(0, 7)} changes src/tool\\.js`));
  const failed = aos(root, ['trailer', 'check', 'ORD-0001', '--from', base]);
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, new RegExp(`${bad.slice(0, 7)} changes src/tool\\.js`));
  assert.match(failed.stdout, /1 of 4 commit\(s\)/);
  assert.equal(trailerCheck(root, 'ORD-0001', { from: base }).problems.length, 1);
});

test('aos trailer check: the trailer of another order is not the trailer of this one; usage and a missing commit are said', () => {
  const root = repo();
  startRun(root);
  const base = head(root);
  commit(root, { 'src/tool.js': 'export const x = 2;\n' }, 'work of another order\n\nAnalucia-Order: ORD-0002');
  commit(root, { 'src/tool.js': 'export const x = 3;\n' }, 'work\n\nAnalucia-Order: ORD-0001');
  const r = aos(root, ['trailer', 'check', 'ORD-0001', '--from', base]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /carries the trailer of ORD-0002, not of ORD-0001/);
  assert.equal(aos(root, ['trailer', 'check', 'ORD-0001']).status, 2, 'no --from: usage');
  const none = aos(root, ['trailer', 'check', 'ORD-0009', '--from', base]);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /E_NO_ORDER_COMMIT/);
  const unknown = aos(root, ['trailer', 'check', 'ORD-0001', '--from', 'no-such-commit']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /E_FILE_MISSING .*no-such-commit/);
});

test('the preflight checks the push guard itself: no hook fails, with the one command; the hook under core.hooksPath passes', () => {
  const root = repo();
  assert.equal(pushGuardStatus(root).passed, false);
  const pre = aos(root, ['preflight', 'ORD-0001']);
  assert.equal(pre.status, 1);
  assert.match(pre.stdout, /^FAIL push guard installed/m);
  assert.match(pre.stdout, /fix it with: node ".*aos\.mjs" install-git-hooks/);
  // run start: nothing starts, no attempt is consumed.
  const before = readFileSync(logPath(root), 'utf8');
  const start = aos(root, ['run', 'start', 'ORD-0001']);
  assert.equal(start.status, 1);
  assert.match(start.stderr, /E_PREFLIGHT_FAILED .*push guard installed/);
  assert.equal(readFileSync(logPath(root), 'utf8'), before);
  // The one command: the hook is written where git looks for it (core.hooksPath), and the check passes.
  assert.equal(aos(root, ['install-git-hooks']).status, 0);
  assert.equal(git(root, 'config', '--local', '--get', 'core.hooksPath').stdout.trim(), '.githooks');
  assert.equal(pushGuardStatus(root).passed, true);
  const ok = aos(root, ['preflight', 'ORD-0001']);
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  assert.match(ok.stdout, /^PASS push guard installed/m);
  assert.match(aos(root, ['run', 'start', 'ORD-0001']).stdout, /run 1 of 3 started/);

  // The hook in another folder that core.hooksPath names is found there; the default .git/hooks is honoured too.
  mkdirSync(join(root, 'tools', 'hooks'), { recursive: true });
  writeFileSync(join(root, 'tools', 'hooks', 'pre-push'), readFileSync(join(root, '.githooks', 'pre-push')));
  git(root, 'config', '--local', 'core.hooksPath', 'tools/hooks');
  assert.equal(pushGuardStatus(root).passed, true);
  git(root, 'config', '--local', '--unset', 'core.hooksPath');
  assert.equal(pushGuardStatus(root).passed, false, 'git now looks in .git/hooks, where there is none');
  writeFileSync(join(root, '.git', 'hooks', 'pre-push'), '#!/bin/sh\nexit 0\n');
  const other = pushGuardStatus(root);
  assert.equal(other.passed, false);
  assert.match(other.detail, /does not call "aos check-push"/);
});

test('a hook with a versioned path fails the preflight; install-git-hooks writes one without a version, which finds the newest plugin', () => {
  const root = repo();
  const cfg = mkdtempSync(join(tmpdir(), 'aos-trailer-cfg-'));
  const made = [];
  for (const v of ['0.4.0', '0.10.0', '0.9.0']) {
    const bin = join(cfg, 'plugins', 'cache', 'some-marketplace', 'analucia', v, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'aos.mjs'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.AOS_TEST_OUT, JSON.stringify({ version: '${v}', args: process.argv.slice(2) }));\n`);
    made.push(join(bin, 'aos.mjs'));
  }
  // The hook of before: an absolute path with the version of the day it was installed.
  mkdirSync(join(root, '.githooks'), { recursive: true });
  writeFileSync(join(root, '.githooks', 'pre-push'), `#!/bin/sh\nexec node "${made[0].split('\\').join('/')}" check-push "$1" "$2"\n`);
  git(root, 'config', '--local', 'core.hooksPath', '.githooks');
  const old = pushGuardStatus(root);
  assert.equal(old.passed, false);
  assert.match(old.detail, /carries a version number/);
  const pre = aos(root, ['preflight', 'ORD-0001']);
  assert.equal(pre.status, 1);
  assert.match(pre.stdout, /^FAIL push guard installed/m);
  assert.match(pre.stdout, /install-git-hooks/);

  // Installed from a versioned copy of the plugin: the hook names no version and runs the newest installed one.
  installGitHooks(root, made[0]);
  const text = readFileSync(join(root, '.githooks', 'pre-push'), 'utf8');
  assert.doesNotMatch(text, /\d+\.\d+\.\d+/);
  assert.match(text, /check-push "\$1" "\$2"/);
  assert.equal(pushGuardStatus(root).passed, true);
  const out = join(cfg, 'ran.json');
  const r = spawnSync(findBash(), ['.githooks/pre-push', 'origin', GOOD_URL], { cwd: root, encoding: 'utf8', env: { ...env, CLAUDE_CONFIG_DIR: cfg, AOS_TEST_OUT: out } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), { version: '0.10.0', args: ['check-push', 'origin', GOOD_URL] });
  // No copy of the plugin: the push is refused, and the hook says why.
  const empty = mkdtempSync(join(tmpdir(), 'aos-trailer-empty-'));
  const none = spawnSync(findBash(), ['.githooks/pre-push', 'origin', GOOD_URL], { cwd: root, encoding: 'utf8', env: { ...env, CLAUDE_CONFIG_DIR: empty, AOS_TEST_OUT: out } });
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /plugin was not found/);

  // Installed from a copy with no version in its path (the plugin's own repository, a checkout): unchanged form.
  installGitHooks(root, AOS);
  assert.match(readFileSync(join(root, '.githooks', 'pre-push'), 'utf8'), /exec node ".*bin\/aos\.mjs" check-push "\$1" "\$2"/);
  assert.equal(pushGuardStatus(root).passed, true);
});

test('a project that is not a git repository, or has no remote the guard judges, has no such check', () => {
  const root = repo();
  git(root, 'remote', 'remove', 'origin');
  assert.equal(pushGuardStatus(root), null);
  assert.equal(aos(root, ['preflight', 'ORD-0001']).stdout, 'OK: ORD-0001 has no preflight in its verify file; nothing to run\n');
  const plain = mkdtempSync(join(tmpdir(), 'aos-trailer-plain-'));
  mkdirSync(join(plain, '.analucia'), { recursive: true });
  assert.equal(pushGuardStatus(plain), null);
});

test('the verify templates use the command, and the director entrypoint says so', () => {
  const tpl = (f) => readFileSync(fileURLToPath(new URL(`../templates/${f}`, import.meta.url)), 'utf8');
  assert.match(tpl('verify-file.example.json'), /aos\.mjs trailer check ORD-NNNN --from /);
  assert.match(tpl('director-entry.md'), /aos trailer check <ID> --from <commit>/);
});
