// ORD-0040 part 3: `aos next` prints exactly one line, the single thing that comes next and who does it, in every
// state, in the order of precedence: halt › broken log › project not initialised › drafts or orders waiting for the
// owner › an open run › a blocked order › a queued order › nothing pending. It exits 0 and writes nothing. The
// SessionStart hook shows the same line.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AOS_BIN } from '../lib/cli.mjs';
import { installLaunchers, launcherFile } from '../lib/launchers.mjs';
import { hashLF } from '../lib/lock.mjs';
import { appendEvent, logPath } from '../lib/log.mjs';
import { nextLine, nextStep } from '../lib/next.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
delete env.CLAUDE_PROJECT_DIR;
const posix = (p) => resolve(p).split(sep).join('/');
// The CLI, with --root or from inside a folder: stdout, exit code, and the number of lines printed.
const next = (root) => spawnSync(process.execPath, [AOS, 'next', '--root', root], { encoding: 'utf8', input: '', env });
const nextIn = (cwd) => spawnSync(process.execPath, [AOS, 'next'], { encoding: 'utf8', input: '', env, cwd });
const oneLine = (r, label) => {
  assert.equal(r.status, 0, `${label}: exit 0 (${r.stderr})`);
  assert.equal(r.stderr, '', label);
  assert.ok(r.stdout.endsWith('\n'), label);
  assert.equal(r.stdout.trimEnd().split('\n').length, 1, `${label}: exactly one line: ${r.stdout}`);
  return r.stdout.trimEnd();
};
const noProjectAbove = (dir) => {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, '.analucia'))) return false;
    if (dirname(d) === d) return true;
  }
};

const ORDER = (id) => ['---', `id: ${id}`, `title: Title of ${id}`, 'kind: fix', 'created: 2026-11-14', 'budget_max_minutes: 30', 'budget_max_attempts: 2', 'risk: low', 'cost_effect: none', '---', '', '## Acceptance criteria', '', '- [ ] x', ''].join('\n');
const VERIFY = (id) => JSON.stringify({ order: id, checks: [{ name: 'the check', run: 'exit 0', expect_exit: 0 }] });

// An initialised project (locale en) with the given orders queued.
function project(ids = [], { locale = 'en' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aos-next-'));
  const a = join(root, '.analucia');
  for (const d of ['orders', 'verify', 'evidence', 'drafts']) mkdirSync(join(a, d), { recursive: true });
  writeFileSync(join(a, 'project.json'), `${JSON.stringify({ wip_limit: 3, locale })}\n`);
  writeFileSync(logPath(root), '');
  writeFileSync(join(a, 'evidence', 'report.md'), '# r\n\n## Evidencia\n\nx\n\nOUTCOME: done\n');
  const files = {};
  for (const id of ids) {
    writeFileSync(join(a, 'orders', `${id}.md`), ORDER(id));
    writeFileSync(join(a, 'verify', `${id}.json`), VERIFY(id));
    for (const rel of [`.analucia/orders/${id}.md`, `.analucia/verify/${id}.json`]) files[rel] = hashLF(readFileSync(join(root, rel)));
    appendEvent(root, { type: 'record.created', actor: 'director', subject: id });
    appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: id, payload: { from: 'draft', to: 'ready' } });
    appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: id, payload: { from: 'ready', to: 'queued' } });
  }
  if (ids.length) writeFileSync(join(a, 'director.lock'), JSON.stringify({ files }));
  return root;
}
const aos = (root, args) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input: '', env });
const start = (root, id) => assert.equal(aos(root, ['run', 'start', id]).status, 0);
const finish = (root, id, outcome, extra = []) => assert.equal(aos(root, ['run', 'finish', id, '--outcome', outcome, '--evidence', '.analucia/evidence/report.md', ...extra]).status, 0);
const draft = (root, id, { verify = true } = {}) => {
  writeFileSync(join(root, '.analucia', 'drafts', `${id}.md`), ORDER(id));
  if (verify) writeFileSync(join(root, '.analucia', 'drafts', `${id}.json`), VERIFY(id));
};
const CMD = `node "${AOS_BIN}"`;

test('not initialised: the next step is to start — first the launchers (anyone), then the owner clicks INICIAR', (t) => {
  const bare = mkdtempSync(join(tmpdir(), 'aos-next-bare-'));
  if (!noProjectAbove(bare)) return t.skip('a folder above the temp folder holds .analucia');
  const a = oneLine(nextIn(bare), 'empty folder');
  assert.ok(a.includes(posix(bare)), 'names the folder');
  assert.ok(a.endsWith(`${CMD} launchers install`), `ends with the command as it exists here: ${a}`);
  assert.deepEqual(readdirSync(bare), [], 'nothing written');
  assert.equal(nextStep(bare).who, 'anyone');

  installLaunchers(bare);
  const b = oneLine(nextIn(bare), 'empty folder with launchers');
  assert.ok(b.includes(launcherFile('INICIAR')), `the click: ${b}`);
  assert.doesNotMatch(b, /launchers install/);
  assert.equal(nextStep(bare).who, 'owner');
  // A folder with .analucia/ but no log is not initialised either.
  mkdirSync(join(bare, '.analucia'));
  assert.equal(nextStep(bare, { explicit: true }).key, 'next.init');
  oneLine(next(bare), '.analucia without a log');
});

test('halt comes first, then a broken log', () => {
  const root = project(['ORD-0001']);
  start(root, 'ORD-0001');
  writeFileSync(join(root, '.analucia', 'HALT'), `${JSON.stringify({ reason: 'checking costs', since: '2026-11-14T09:00:00.000-05:00', by: 'owner' })}\n`);
  const halted = oneLine(next(root), 'halt');
  assert.equal(halted, `The project is halted (checking costs). Next (owner): to let the agents work again, run this in your own terminal: ${CMD} resume.`);
  installLaunchers(root);
  assert.equal(oneLine(next(root), 'halt with launchers'), `The project is halted (checking costs). Next (owner): to let the agents work again, double-click ${launcherFile('REANUDAR')} in ${posix(root)}.`);

  // Break the chain at line 1 (the halt still wins while it is there).
  const broken = project(['ORD-0001']);
  writeFileSync(logPath(broken), readFileSync(logPath(broken), 'utf8').replace('"director"', '"Director"'));
  draft(broken, 'ORD-0002');
  const line = oneLine(next(broken), 'broken log');
  assert.match(line, /^The event log is broken at line 2 \(E_CHAIN\)\. Next \(director\): restore \.analucia\/events\.jsonl from git/);
  assert.ok(line.endsWith(`${CMD} verify-log`));
});

test('drafts or orders waiting for the owner come before an open run', () => {
  const root = project(['ORD-0001', 'ORD-0002']);
  start(root, 'ORD-0001');
  draft(root, 'ORD-0003');
  assert.equal(oneLine(next(root), 'draft waiting'), `Next (owner): run this in your own terminal: ${CMD} sign. Waiting for you: 1 draft order(s) to place (ORD-0003).`);
  finish(root, 'ORD-0001', 'done');
  installLaunchers(root, { only: ['FIRMAR'] });
  assert.equal(oneLine(next(root), 'draft and finished order'), `Next (owner): double-click ${launcherFile('FIRMAR')} in ${posix(root)}. Waiting for you: 1 draft order(s) to place (ORD-0003); 1 finished order(s) to sign (ORD-0001).`);
  assert.equal(nextStep(root, { explicit: true }).who, 'owner');
});

test('an open run, then a blocked order, then drafts to fix, then a queued order, then nothing pending', () => {
  const root = project(['ORD-0001', 'ORD-0002']);
  // queued: the first of the queue.
  assert.equal(oneLine(next(root), 'queued'), `Next (executor): start ORD-0001 (Title of ORD-0001) with: ${CMD} run start ORD-0001`);
  // open run.
  start(root, 'ORD-0001');
  assert.equal(oneLine(next(root), 'open run'), `Next (executor): run 1 of ORD-0001 is open. Finish the work, then record its outcome with: ${CMD} run finish ORD-0001 --outcome <outcome> --evidence .analucia/evidence/ORD-0001/report.md`);
  // blocked (before the queued ORD-0002).
  finish(root, 'ORD-0001', 'needs_decision', ['--reason', 'the spec and the order disagree']);
  assert.equal(oneLine(next(root), 'blocked'), `Next (director): ORD-0001 is blocked (the spec and the order disagree). Decide how it continues: the answer it waits for, or a new draft order. When what it waits for is done, the executor takes it out with: node "${AOS_BIN}" resume-order ORD-0001 --reason "<why the block has ended>"`); // ORD-0043 part 3: the exact line
  // a draft that cannot be placed is the director's to fix, after the blocked order is dealt with.
  const other = project(['ORD-0001']);
  draft(other, 'ORD-0002', { verify: false });
  assert.equal(oneLine(next(other), 'draft to fix'), `Next (director): 1 draft order(s) cannot be placed yet (ORD-0002). See the reason of each one with: ${CMD} drafts`);
  // nothing pending.
  const empty = project();
  assert.equal(oneLine(next(empty), 'nothing'), 'Nothing is pending. Next (owner): tell your session what you need; it writes a draft order (how: .analucia/DIRECTOR.md) and you place it with FIRMAR.');
});

test('the line follows the project language, and aos next writes nothing', () => {
  const root = project(['ORD-0001'], { locale: 'es' });
  const before = readFileSync(logPath(root), 'utf8');
  const files = readdirSync(join(root, '.analucia')).sort();
  assert.equal(oneLine(next(root), 'es'), `Siguiente paso (ejecutor): empezar ORD-0001 (Title of ORD-0001) con: ${CMD} run start ORD-0001`);
  assert.equal(readFileSync(logPath(root), 'utf8'), before);
  assert.deepEqual(readdirSync(join(root, '.analucia')).sort(), files, 'no view, no lock, nothing');
  for (const l of ['en', 'es', 'pt', 'zh-Hans', 'hi']) assert.equal(nextLine(root, { explicit: true, locale: l }).split('\n').length, 1, l);
});

test('the SessionStart hook shows the same line as aos next', (t) => {
  const root = project(['ORD-0001']);
  const hook = (cwd) => spawnSync(process.execPath, [AOS, 'hook', 'session-start'], { encoding: 'utf8', env, cwd, input: JSON.stringify({ cwd, source: 'startup' }) });
  const expected = oneLine(next(root), 'cli');
  const lines = hook(root).stdout.split('\n');
  assert.match(lines[0], /^Status: /);
  assert.match(lines[1], /^Project root: /);
  assert.equal(lines[2], expected);
  const bare = mkdtempSync(join(tmpdir(), 'aos-next-hook-'));
  if (!noProjectAbove(bare)) return t.skip('a folder above the temp folder holds .analucia');
  assert.equal(hook(bare).stdout, nextIn(bare).stdout);
});
