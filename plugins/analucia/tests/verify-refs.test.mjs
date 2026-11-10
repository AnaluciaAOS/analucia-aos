// ORD-0034: a verify check may never depend on a moving ref (E_MOVING_REF), and aos verify resolves
// {order_commit} (E_NO_ORDER_COMMIT when no commit has the trailer). Every test runs in a temporary directory.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hashLF } from '../lib/lock.mjs';
import { appendEvent, logPath, readLog } from '../lib/log.mjs';
import { replay } from '../lib/state.mjs';
import { scanMovingRefs } from '../lib/verify-refs.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const TEMPLATE = fileURLToPath(new URL('../templates/verify-file.example.json', import.meta.url));
const env = { ...process.env };
delete env.CLAUDE_PROJECT_DIR;
const aos = (root, args) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { cwd: root, encoding: 'utf8', env });
const git = (root, ...args) => {
  const r = spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const SHORT = '8ea118d';
const FULL = '82fb2ce8d0ccd0cdb23dfebf3188d6f38e6643a4';

// A scratch project (a git repository) with one order ORD-0001 and its verify file.
function project({ checks, pins = null, admitted = false, branch = null }) {
  const root = mkdtempSync(join(tmpdir(), 'aos-refs-'));
  const a = join(root, '.analucia');
  for (const d of ['orders', 'verify', 'evidence']) mkdirSync(join(a, d), { recursive: true });
  writeFileSync(join(a, 'project.json'), '{"wip_limit":3}\n');
  writeFileSync(logPath(root), '');
  writeFileSync(join(a, 'orders', 'ORD-0001.md'), ['---', 'id: ORD-0001', 'title: Refs fixture', 'kind: build', 'created: 2026-11-08',
    'budget_max_minutes: 60', 'budget_max_attempts: 2', 'risk: low', 'cost_effect: [build]', '---', '', '# ORD-0001', '', '## Acceptance criteria', '', '- [ ] It works.', ''].join('\n'));
  writeFileSync(join(a, 'verify', 'ORD-0001.json'), `${JSON.stringify({ order: 'ORD-0001', checks }, null, 2)}\n`);
  writeFileSync(join(a, 'evidence', 'report.md'), 'evidence\n');
  const files = {};
  for (const rel of ['.analucia/orders/ORD-0001.md', '.analucia/verify/ORD-0001.json']) files[rel] = hashLF(readFileSync(join(root, rel)));
  writeFileSync(join(a, 'director.lock'), `${JSON.stringify({ written_by: 'director', files }, null, 2)}\n`);
  if (admitted) {
    appendEvent(root, { type: 'record.created', actor: 'director', subject: 'ORD-0001', payload: pins ? { pins } : {} });
    appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: 'ORD-0001', payload: { from: 'draft', to: 'ready' } });
    appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: 'ORD-0001', payload: { from: 'ready', to: 'queued' } });
  }
  git(root, 'init', '-q', '-b', 'trunk');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  if (branch) git(root, 'branch', branch);
  return root;
}
const check = (run) => [{ name: 'x', run, expect_exit: 0 }];
const validate = (root) => aos(root, ['validate', root]);

test('a check that ends a diff range at HEAD fails validate with E_MOVING_REF (unadmitted order)', () => {
  const root = project({ checks: check(`git diff --quiet ${SHORT} HEAD -- core`) });
  const r = validate(root);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /ORD-0001\.json:\d+: E_MOVING_REF checks\[0\] \(check 1\): moving ref "HEAD" \(git diff\).*Use a commit SHA or \{order_commit\}/);
  assert.match(r.stdout, /next \(director\): .*docs\/errors\/E_MOVING_REF\.md/);
  assert.doesNotMatch(r.stdout, /^warning:/m);
  rmSync(root, { recursive: true, force: true });
});

test('HEAD~1, main, origin/main, refs/remotes/origin/x, a local branch, A.. and @{u} each fail', () => {
  const runs = [
    `git diff --quiet ${SHORT} HEAD~1 -- core`,
    `git diff --name-only ${SHORT} main`,
    `git log --oneline ${SHORT}..origin/main`,
    `git rev-list --count ${SHORT}...refs/remotes/origin/x`,
    `git diff --quiet ${SHORT} feature-x -- core`,
    `git log --format=%H ${SHORT}..`,
    `git diff ${SHORT} @{u}`,
    `! git -C . diff --name-only ${SHORT} master | grep -q .`,
    `c=$(git diff --name-only ${SHORT} HEAD | wc -l); test "$c" = 0`,
  ];
  const root = project({ checks: runs.map((run, i) => ({ name: `c${i}`, run, expect_exit: 0 })), branch: 'feature-x' });
  const r = validate(root);
  assert.equal(r.status, 1, r.stdout);
  for (let i = 0; i < runs.length; i++) assert.match(r.stdout, new RegExp(`E_MOVING_REF checks\\[${i}\\] `), `run ${i}: ${runs[i]}`);
  assert.match(r.stdout, /moving ref "feature-x"/);
  rmSync(root, { recursive: true, force: true });
});

test('short and full SHAs, {order_commit} and {order_commit}^ pass', () => {
  const root = project({ checks: [
    { name: 'a', run: `git diff --quiet ${SHORT} ${FULL} -- core`, expect_exit: 0 },
    { name: 'b', run: `git diff --quiet ${SHORT} {order_commit} -- core`, expect_exit: 0 },
    { name: 'c', run: `git log --oneline ${SHORT}..{order_commit}^`, expect_exit: 0 },
    { name: 'd', run: `git diff ${FULL}~2 ${SHORT}^2`, expect_exit: 0 },
  ] });
  const r = validate(root);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.stdout, '');
  rmSync(root, { recursive: true, force: true });
});

test('git log --grep, pathspecs, single revisions and quoted text pass (director design note)', () => {
  const root = project({ checks: [
    { name: 'a', run: "test \"$(git log --format=%H --grep='^Analucia-Order: ORD-0001$' | wc -l | tr -d ' ')\" = 1", expect_exit: 0 },
    { name: 'b', run: `! git diff --name-only ${SHORT} ${FULL} -- .analucia ':!.analucia/orders/ORD-0001.md' | grep -q .`, expect_exit: 0 },
    { name: 'c', run: `git merge-base --is-ancestor ${SHORT} HEAD`, expect_exit: 0 },
    { name: 'd', run: 'node scripts/build-public-tree.mjs "$t/tree" --ref HEAD >/dev/null', expect_exit: 0 },
    { name: 'e', run: 'git rev-parse --verify -q refs/remotes/origin/backup/2026-10-27', expect_exit: 0 },
    { name: 'f', run: 'git diff --exit-code README.md && git check-attr eol .analucia/events.jsonl', expect_exit: 0 },
    { name: 'g', run: "printf '%s' 'git diff --quiet 8ea118d HEAD -- core' > x.txt", expect_exit: 0 },
  ] });
  const r = validate(root);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.stdout, '');
  rmSync(root, { recursive: true, force: true });
});

test('the same HEAD check of an order admitted with pins.plugin 0.2.0 is a warning and exits 0; with 0.3.0 it is an error', () => {
  const old = project({ checks: check(`git diff --quiet ${SHORT} HEAD -- core`), admitted: true, pins: { plugin: '0.2.0', specs: {} } });
  const r = validate(old);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.stdout.match(/^warning: .*E_MOVING_REF/gm).length, 1, 'printed once per check');
  const legacy = project({ checks: check(`git diff --quiet ${SHORT} HEAD -- core`), admitted: true });
  assert.equal(validate(legacy).status, 0);
  const now = project({ checks: check(`git diff --quiet ${SHORT} HEAD -- core`), admitted: true, pins: { plugin: '0.3.0', specs: {} } });
  const n = validate(now);
  assert.equal(n.status, 1, n.stdout);
  assert.doesNotMatch(n.stdout, /^warning:/m);
  for (const root of [old, legacy, now]) rmSync(root, { recursive: true, force: true });
});

test('a single verify file is judged against the project of the current directory', () => {
  const root = project({ checks: check('exit 0'), admitted: true, pins: { plugin: '0.2.0', specs: {} } });
  const file = join(root, 'ORD-9999.json');
  writeFileSync(file, `${JSON.stringify({ order: 'ORD-9999', checks: check(`git diff --quiet ${SHORT} HEAD -- core`) })}\n`);
  const r = spawnSync(process.execPath, [AOS, 'validate', file], { cwd: root, encoding: 'utf8', env });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /E_MOVING_REF/);
  rmSync(root, { recursive: true, force: true });
});

test('aos admit refuses an order whose verify file has a moving ref (E_MOVING_REF)', () => {
  const root = project({ checks: check(`git diff --quiet ${SHORT} HEAD -- core`) });
  const r = aos(root, ['admit', 'ORD-0001']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /: E_MOVING_REF /);
  assert.equal(readLog(root).events.length, 0);
  rmSync(root, { recursive: true, force: true });
  const ok = project({ checks: check(`git diff --quiet ${SHORT} {order_commit} -- core`) });
  assert.equal(aos(ok, ['admit', 'ORD-0001']).status, 0);
  rmSync(ok, { recursive: true, force: true });
});

test('the verify-file template uses {order_commit} and passes validate when copied as ORD-NNNN.json', () => {
  const text = readFileSync(TEMPLATE, 'utf8');
  assert.match(text, /\{order_commit\}/);
  const root = project({ checks: check('exit 0') });
  writeFileSync(join(root, '.analucia', 'verify', 'ORD-0001.json'), text.replace(/ORD-NNNN/g, 'ORD-0001'));
  const r = validate(root);
  assert.equal(r.status, 0, r.stdout);
  rmSync(root, { recursive: true, force: true });
});

// Delivers ORD-0001 (admitted, run started and finished as done).
function delivered(checks) {
  const root = project({ checks, admitted: true, pins: { plugin: '0.3.0', specs: {} } });
  for (const args of [['run', 'start', 'ORD-0001'], ['run', 'finish', 'ORD-0001', '--outcome', 'done', '--evidence', '.analucia/evidence/report.md']]) {
    const r = aos(root, args);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  }
  return root;
}

test('aos verify resolves {order_commit} to the newest commit with the trailer and shows the check as written and resolved', () => {
  const root = delivered(check('test "$(git log -1 --format=%s {order_commit})" = work && git cat-file -e {order_commit}^'));
  writeFileSync(join(root, 'a.txt'), 'a\n');
  git(root, 'add', 'a.txt');
  git(root, 'commit', '-q', '-m', 'work\n\nAnalucia-Order: ORD-0001');
  const sha = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'b.txt'), 'b\n');
  git(root, 'add', 'b.txt');
  git(root, 'commit', '-q', '-m', 'later work of another order');
  const r = aos(root, ['verify', 'ORD-0001']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(replay(readLog(root).events).orders['ORD-0001'].state, 'verified');
  const evidence = readFileSync(join(root, '.analucia', 'evidence', 'ORD-0001', 'verify-01.txt'), 'utf8');
  assert.match(evidence, /\$ test .*\{order_commit\}/);
  assert.ok(evidence.includes(`resolved: $ test "$(git log -1 --format=%s ${sha})" = work`), evidence);
  assert.ok(evidence.includes(`{order_commit} = ${sha}`));
  rmSync(root, { recursive: true, force: true });
});

test('aos verify fails the check with E_NO_ORDER_COMMIT when no commit has the trailer', () => {
  const root = delivered(check(`git diff --quiet {order_commit} {order_commit}`));
  const r = aos(root, ['verify', 'ORD-0001']);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /E_VERIFY_FAILED/);
  assert.equal(replay(readLog(root).events).orders['ORD-0001'].state, 'delivered');
  const evidence = readFileSync(join(root, '.analucia', 'evidence', 'ORD-0001', 'verify-01.txt'), 'utf8');
  assert.match(evidence, /not run: E_NO_ORDER_COMMIT no commit has the trailer line "Analucia-Order: ORD-0001"/);
  assert.match(evidence, /next \(executor\): Commit with the trailer .*E_NO_ORDER_COMMIT\.md/);
  rmSync(root, { recursive: true, force: true });
});

test('scanMovingRefs: only the end of a range is judged', () => {
  assert.deepEqual(scanMovingRefs('git log HEAD..8ea118d'), []);
  assert.deepEqual(scanMovingRefs('git log --oneline HEAD'), []);
  assert.deepEqual(scanMovingRefs('git diff HEAD'), []);
  assert.deepEqual(scanMovingRefs('git diff 8ea118d HEAD^'), [{ token: 'HEAD^', command: 'git diff' }]);
  assert.deepEqual(scanMovingRefs('git -c core.x=1 diff-tree -r 8ea118d ORIG_HEAD'), [{ token: 'ORIG_HEAD', command: 'git diff-tree' }]);
});
