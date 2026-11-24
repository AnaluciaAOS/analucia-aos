// ORD-0040 part 2: `aos init` in a project that already runs (commits and its own CLAUDE.md), OBS-126 to OBS-130.
// The director entrypoint, the bootstrap order offered as a draft, director.lock written by the tool at the first
// placement, the hook message that says where a draft goes, and a second init that changes nothing.
// Item 1 as amended by AMD-0013 (spec text: AMD-0014): a previous CLAUDE.md without director instructions keeps every
// line and gains the import on top; one with director instructions (the E_ROLES conflict) moves whole to
// CLAUDE.previous.md, only after the owner types CONFIRM, and CLAUDE.md then holds only "@AGENTS.md". With --check,
// with --dry-run or without the confirmation nothing is moved: the conflict stays a FAIL whose next step names INICIAR.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BOOTSTRAP_ID, listDrafts, needsBootstrap } from '../lib/drafts.mjs';
import { checkLock, readLock } from '../lib/lock.mjs';
import { readLog } from '../lib/log.mjs';
import { runChecks } from '../lib/checks.mjs';
import { onboardingStarted, runInit } from '../lib/onboarding.mjs';
import { sign } from '../lib/sign.mjs';
import { replay } from '../lib/state.mjs';
import { validateLockText } from '../lib/validate.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
delete env.CLAUDE_PROJECT_DIR;
const aos = (root, args, input = '') => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input, env });
const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' });
const OWN_CLAUDE = '# Shop backend\n\nAlways run npm test before committing.\nNever touch the payments folder without asking.\n';
const ANSWERS = { purpose: 'A shop that already runs', github_owner: 'example', owner_locale: 'en' };

// A project that already runs: two commits, its own CLAUDE.md, no trace of the Loop.
function runningProject({ claude = OWN_CLAUDE, commits = 2 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aos-running-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 't');
  git(root, 'config', 'user.email', 't@example.com');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'README.md'), '# Shop\n');
  if (claude !== null) writeFileSync(join(root, 'CLAUDE.md'), claude);
  for (let i = 1; i <= commits; i++) {
    writeFileSync(join(root, 'src', `file${i}.js`), `export const n = ${i};\n`);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', `work ${i} before the Loop`);
  }
  return root;
}
// The owner at the terminal: CONFIRM for init. The first real apply creates the log, as the CLI does.
const init = async (root, { dryRun = false, first = true } = {}) => {
  const lines = [];
  const r = await runInit(root, {
    provided: ANSWERS, locale: 'en', dryRun, isTTY: true, ask: async () => 'CONFIRM', out: (s) => lines.push(s),
    ...(first && !dryRun ? { onConfirmed: () => onboardingStarted(root) } : {}),
  });
  return { ...r, text: lines.join('\n') };
};
function snapshot(root) {
  const out = {};
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      if (f === '.git') continue;
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p); else out[relative(root, p).split('\\').join('/')] = readFileSync(p, 'utf8');
    }
  };
  walk(root);
  return out;
}

test('the plan shows what init will leave for the director before CONFIRM, and a dry run writes nothing', async () => {
  const root = runningProject();
  const before = snapshot(root);
  const { text } = await init(root, { dryRun: true });
  assert.match(text, /Director entrypoint: how to write a draft order \(\.analucia\/DIRECTOR\.md\): created/);
  assert.match(text, /First order, already written, as a draft for the commits made before Analucia \(\.analucia\/drafts\/ORD-0001\): created/);
  assert.match(text, /Files git never saves \(\.gitignore: generated views, the log lock\): created/);
  assert.deepEqual(snapshot(root), before);
});

test('init in a project with commits and its own CLAUDE.md: roles pass, nothing lost, the director entrypoint and the bootstrap draft are there', async () => {
  const root = runningProject();
  assert.equal(needsBootstrap(root), true);
  await init(root);

  // Roles: the executor entrypoint imports @AGENTS.md and every line of the owner's file is still there.
  const claude = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
  for (const line of OWN_CLAUDE.split('\n').filter(Boolean)) assert.ok(claude.split('\n').includes(line), `kept: ${line}`);
  assert.equal(claude.split('\n')[0], '@AGENTS.md');
  const roles = aos(root, ['check-roles']);
  assert.equal(roles.status, 0, roles.stderr);

  // The director entrypoint is a file of its own (not CLAUDE.md), with the real commands of this machine.
  const entry = readFileSync(join(root, '.analucia', 'DIRECTOR.md'), 'utf8');
  assert.match(entry, /\.analucia\/drafts\/draft-<topic>\.md/);
  assert.match(entry, /An order without its verify file is not placed/);
  assert.ok(entry.includes(`node "${AOS.split('\\').join('/')}" drafts`), 'the drafts command as it exists here');
  assert.doesNotMatch(entry, /node plugins\/analucia\/bin\/aos\.mjs/);

  // The bootstrap order is offered already written, as a valid draft with its verify file.
  const drafts = listDrafts(root);
  assert.deepEqual(drafts.map((d) => [d.id, d.ok, d.problems]), [[BOOTSTRAP_ID, true, []]]);
  assert.match(drafts[0].title, /Bring the commits that predate the Loop under an order/);
  const order = readFileSync(join(root, '.analucia', 'drafts', 'ORD-0001.md'), 'utf8');
  assert.match(order, /^created: \d{4}-\d{2}-\d{2}$/m);
  assert.doesNotMatch(order, /\{created\}/);
  assert.equal(aos(root, ['drafts']).status, 0);

  // director.lock is never written by hand: none yet (nothing is placed), and nothing protected was created.
  assert.equal(existsSync(join(root, '.analucia', 'director.lock')), false);
  assert.deepEqual(readdirSync(join(root, '.analucia', 'orders')), []);
  // The lock of the single writer and the generated views are ignored.
  const ignore = readFileSync(join(root, '.gitignore'), 'utf8').split('\n');
  assert.ok(ignore.includes('.analucia/views/') && ignore.includes('.analucia/events.jsonl.lock*'));

  // A second init changes nothing: no file, no event, no second draft.
  const first = snapshot(root);
  const events = readLog(root).events.length;
  const again = await init(root, { first: false });
  assert.deepEqual(again.items.filter((i) => i.status !== 'unchanged').map((i) => i.item), []);
  assert.deepEqual(snapshot(root), first);
  assert.equal(readLog(root).events.length, events);
});

test('the owner places the bootstrap order with one confirmation: director.lock is written by the tool and validates', async () => {
  const root = runningProject();
  await init(root);
  const lines = [];
  const r = await sign(root, { isTTY: true, push: false, out: (s) => lines.push(s), ask: async () => 'PLACE' });
  assert.deepEqual(r.placed, [BOOTSTRAP_ID]);
  const lock = readLock(root);
  assert.deepEqual(validateLockText(readFileSync(join(root, '.analucia', 'director.lock'), 'utf8')), []);
  assert.deepEqual(Object.keys(lock.files).sort(), ['.analucia/orders/ORD-0001.md', '.analucia/verify/ORD-0001.json']);
  assert.deepEqual(checkLock(root), []);
  assert.equal(replay(readLog(root).events).orders[BOOTSTRAP_ID].state, 'queued');
  assert.equal(aos(root, ['validate']).status, 0, aos(root, ['validate']).stdout);
  assert.equal(aos(root, ['verify-log']).status, 0);
  // Placed once: a later init offers no second bootstrap.
  assert.equal(needsBootstrap(root), false);
  const again = await init(root, { first: false });
  assert.equal(again.items.find((i) => i.item === 'bootstrap_draft').status, 'unchanged');
  assert.equal(existsSync(join(root, '.analucia', 'drafts', 'ORD-0001.md')), false);
});

test('no commit before the Loop, or no git at all: no bootstrap draft is offered', async () => {
  const fresh = runningProject({ commits: 0, claude: null });
  assert.equal(needsBootstrap(fresh), false);
  await init(fresh);
  assert.deepEqual(listDrafts(fresh), []);
  assert.ok(existsSync(join(fresh, '.analucia', 'DIRECTOR.md')));
  assert.equal(readFileSync(join(fresh, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
  const bare = mkdtempSync(join(tmpdir(), 'aos-running-nogit-'));
  assert.equal(needsBootstrap(bare), false);
});

test('a blocked write of an order says where a draft goes and that an order needs its verify file (OBS-127)', async () => {
  const root = runningProject();
  await init(root);
  const hook = (tool_name, tool_input) => spawnSync(process.execPath, [AOS, 'hook', 'pre-tool-use'], { encoding: 'utf8', env: { ...env, CLAUDE_PROJECT_DIR: root }, input: JSON.stringify({ tool_name, tool_input, cwd: root }) });
  const blocked = hook('Write', { file_path: join(root, '.analucia', 'orders', 'ORD-0002.md'), content: 'x' });
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /blocked Write on \.analucia\/orders\/ORD-0002\.md: a protected path/);
  assert.match(blocked.stderr, /write a draft instead: \.analucia\/drafts\/ORD-NNNN\.md together with its verify file \.analucia\/drafts\/ORD-NNNN\.json \(an order without its verify file is not placed\)/);
  assert.match(blocked.stderr, /\.analucia\/DIRECTOR\.md/);
  const shell = hook('Bash', { command: 'echo x > .analucia/verify/ORD-0002.json' });
  assert.equal(shell.status, 2);
  assert.match(shell.stderr, /write a draft instead/);
  // Another protected path keeps its message without the draft hint; a draft itself is not blocked.
  const lock = hook('Write', { file_path: join(root, '.analucia', 'director.lock'), content: '{}' });
  assert.equal(lock.status, 2);
  assert.doesNotMatch(lock.stderr, /write a draft instead/);
  assert.equal(hook('Write', { file_path: join(root, '.analucia', 'drafts', 'ORD-0002.md'), content: 'x' }).status, 0);
});

// ---------- AMD-0013 Change 1: the previous CLAUDE.md ----------

const WITH_DIRECTOR = '# Project\r\n\r\nYou are the director of this project: write the orders.\r\nAlways run npm test before committing.\r\n';
const initWith = async (root, { answer = 'CONFIRM', dryRun = false, first = true } = {}) => {
  const lines = [];
  const r = await runInit(root, {
    provided: ANSWERS, locale: 'en', dryRun, isTTY: true, ask: async () => answer, out: (s) => lines.push(s),
    ...(first && !dryRun ? { onConfirmed: () => onboardingStarted(root) } : {}),
  });
  return { ...r, text: lines.join('\n') };
};

test('case 1 — no director instructions: every line is kept, the import goes on top, nothing is moved, check-roles exits 0', async () => {
  const root = runningProject();
  const { text } = await initWith(root);
  assert.equal(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), `@AGENTS.md\n\n${OWN_CLAUDE}`);
  assert.equal(existsSync(join(root, 'CLAUDE.previous.md')), false);
  assert.doesNotMatch(text, /CLAUDE\.previous\.md/);
  assert.equal(aos(root, ['check-roles']).status, 0);
});

test('case 2 — director instructions: the plan shows the move before CONFIRM; after it the whole file is in CLAUDE.previous.md and CLAUDE.md holds only @AGENTS.md', async () => {
  const root = runningProject({ claude: WITH_DIRECTOR });
  const prompts = [];
  const lines = [];
  let seenBeforeConfirm = null;
  await runInit(root, {
    provided: ANSWERS, locale: 'en', isTTY: true, out: (s) => lines.push(s), onConfirmed: () => onboardingStarted(root),
    ask: async (q) => {
      prompts.push(q);
      seenBeforeConfirm = { plan: lines.join('\n'), claude: readFileSync(join(root, 'CLAUDE.md'), 'utf8'), moved: existsSync(join(root, 'CLAUDE.previous.md')) };
      return 'CONFIRM';
    },
  });
  // Before the confirmation: the plan says it, and nothing has moved.
  assert.match(prompts[0], /Type CONFIRM to apply/);
  assert.equal(seenBeforeConfirm.claude, WITH_DIRECTOR);
  assert.equal(seenBeforeConfirm.moved, false);
  assert.match(seenBeforeConfirm.plan, /CLAUDE\.md imports @AGENTS\.md: updated/);
  assert.match(seenBeforeConfirm.plan, /Your current CLAUDE\.md has director instructions \(1 line\(s\)\)\. The whole file moves to CLAUDE\.previous\.md and the new CLAUDE\.md holds only the line @AGENTS\.md\. No line is lost\./);
  assert.match(seenBeforeConfirm.plan, /is no longer loaded by itself/);
  assert.match(seenBeforeConfirm.plan, /project rules in AGENTS\.md, outside the Analucia block; director instructions in \.analucia\/DIRECTOR\.md/);
  // After: no line lost (byte for byte), only the import left, roles pass.
  assert.equal(readFileSync(join(root, 'CLAUDE.previous.md'), 'utf8'), WITH_DIRECTOR, 'the whole previous file, as it was');
  assert.equal(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
  const roles = aos(root, ['check-roles']);
  assert.equal(roles.status, 0, roles.stderr);
  // A second init changes nothing.
  const first = snapshot(root);
  const again = await initWith(root, { first: false });
  assert.deepEqual(again.items.filter((i) => i.status !== 'unchanged').map((i) => i.item), []);
  assert.doesNotMatch(again.text, /CLAUDE\.previous/);
  assert.deepEqual(snapshot(root), first);
});

test('case 2 — CLAUDE.previous.md already exists: a numbered name is used and the older file is not touched', async () => {
  const root = runningProject({ claude: WITH_DIRECTOR });
  writeFileSync(join(root, 'CLAUDE.previous.md'), 'an older file\n');
  writeFileSync(join(root, 'CLAUDE.previous.2.md'), 'another older file\n');
  const { text } = await initWith(root);
  assert.match(text, /The whole file moves to CLAUDE\.previous\.3\.md/);
  assert.equal(readFileSync(join(root, 'CLAUDE.previous.md'), 'utf8'), 'an older file\n');
  assert.equal(readFileSync(join(root, 'CLAUDE.previous.2.md'), 'utf8'), 'another older file\n');
  assert.equal(readFileSync(join(root, 'CLAUDE.previous.3.md'), 'utf8'), WITH_DIRECTOR);
  assert.equal(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
  // The import line was already there and the director line too: still the conflict, still moved whole.
  const both = runningProject({ claude: `@AGENTS.md\n\n${WITH_DIRECTOR}` });
  await initWith(both);
  assert.equal(readFileSync(join(both, 'CLAUDE.previous.md'), 'utf8'), `@AGENTS.md\n\n${WITH_DIRECTOR}`);
  assert.equal(readFileSync(join(both, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
});

test('case 3 — with --dry-run, without the confirmation, or without a terminal: nothing is moved', async () => {
  const root = runningProject({ claude: WITH_DIRECTOR });
  const before = snapshot(root);
  const dry = await initWith(root, { dryRun: true });
  assert.match(dry.text, /The whole file moves to CLAUDE\.previous\.md/);
  assert.match(dry.text, /Dry run: nothing was written\./);
  assert.deepEqual(snapshot(root), before, 'dry run');
  for (const answer of ['', 'yes', 'confirm']) {
    await assert.rejects(initWith(root, { answer }), (x) => x.code === 'E_NOT_CONFIRMED');
    assert.deepEqual(snapshot(root), before, `answer ${JSON.stringify(answer)}`);
  }
  // An agent (no terminal): the real command is refused, the dry run of the CLI writes nothing.
  writeFileSync(join(root, '..', 'answers-amd13.json'), JSON.stringify({ locale: 'en', answers: ANSWERS }));
  const refused = aos(root, ['init', '--answers', join(root, '..', 'answers-amd13.json')], 'CONFIRM\n');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /E_OWNER_TTY/);
  const cli = aos(root, ['init', '--answers', join(root, '..', 'answers-amd13.json'), '--dry-run']);
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /The whole file moves to CLAUDE\.previous\.md/);
  assert.deepEqual(snapshot(root), before, 'no terminal');
});

test('case 3 — aos init --check and aos check-roles: the conflict stays a FAIL, nothing is moved, and the next step names INICIAR', async () => {
  // A project that was initialised when its CLAUDE.md had no conflict, and gained director instructions afterwards.
  const root = runningProject();
  await initWith(root);
  const conflicted = `@AGENTS.md\n\n${WITH_DIRECTOR}`;
  writeFileSync(join(root, 'CLAUDE.md'), conflicted);
  const { results, failed } = runChecks(root, { lsRemote: () => ({ ok: false, ms: 0 }), install: { entries: [], marketplaceKnown: true } });
  const check = results.find((r) => r.name === 'claude_md');
  assert.equal(check.status, 'FAIL');
  assert.equal(check.next.who, 'owner');
  assert.equal(failed, true);
  const cli = aos(root, ['init', '--check']);
  assert.equal(cli.status, 1);
  assert.match(cli.stdout, /^FAIL claude_md: CLAUDE\.md has director instructions \(1 line\(s\)\); the executor entrypoint holds only @AGENTS\.md$/m);
  assert.match(cli.stdout, /next \(owner\): Double-click INICIAR in the project folder/);
  assert.match(cli.stdout, /CLAUDE\.previous\.md/);
  const roles = aos(root, ['check-roles']);
  assert.equal(roles.status, 1);
  assert.match(roles.stderr, /E_ROLES CLAUDE\.md contains director instructions/);
  assert.match(roles.stderr, /INICIAR/);
  assert.equal(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), conflicted, 'nothing moved by a check');
  assert.equal(existsSync(join(root, 'CLAUDE.previous.md')), false);
  // Without the conflict the check is not listed at all (the list of SPEC-0005 §5 is unchanged for every other project).
  const clean = runningProject();
  await initWith(clean);
  assert.equal(runChecks(clean, { lsRemote: () => ({ ok: false, ms: 0 }), install: { entries: [], marketplaceKnown: true } }).results.some((r) => r.name === 'claude_md'), false);
});

test('case 4 — after the confirmed move in a project already initialised: check-roles exits 0 and a second init changes nothing', async () => {
  const root = runningProject();
  await initWith(root);
  const conflicted = `@AGENTS.md\n\n${WITH_DIRECTOR}`;
  writeFileSync(join(root, 'CLAUDE.md'), conflicted);
  assert.equal(aos(root, ['check-roles']).status, 1);
  const moved = await initWith(root, { first: false });
  assert.deepEqual(moved.items.filter((i) => i.status !== 'unchanged').map((i) => i.item), ['claude_md']);
  assert.equal(readFileSync(join(root, 'CLAUDE.previous.md'), 'utf8'), conflicted);
  assert.equal(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
  assert.equal(aos(root, ['check-roles']).status, 0);
  assert.equal(aos(root, ['init', '--check']).stdout.includes('claude_md'), false);
  const first = snapshot(root);
  const events = readLog(root).events.length;
  const again = await initWith(root, { first: false });
  assert.deepEqual(again.items.filter((i) => i.status !== 'unchanged').map((i) => i.item), []);
  assert.deepEqual(snapshot(root), first);
  assert.equal(readLog(root).events.length, events);
});
