// ORD-0040 part 2: a director writes drafts in .analucia/drafts/; only the owner's typed confirmation in `aos sign`
// places them (copied to the protected paths, hashed into director.lock by the tool, admitted). A draft that does
// not validate is not placed and its reason is shown. An agent cannot give the confirmation.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { listDrafts, nextOrderId } from '../lib/drafts.mjs';
import { isProtected } from '../lib/guards.mjs';
import { checkLock, hashLF, readLock } from '../lib/lock.mjs';
import { logPath, readLog, verifyChain } from '../lib/log.mjs';
import { sign } from '../lib/sign.mjs';
import { replay } from '../lib/state.mjs';
import { validateLockText } from '../lib/validate.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
delete env.CLAUDE_PROJECT_DIR;
const aos = (root, args, input = '') => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input, env });
const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' });

const order = (id, extra = []) => ['---', `id: ${id}`, `title: Title of ${id}`, 'kind: fix', 'created: 2026-11-14', 'budget_max_minutes: 30', 'budget_max_attempts: 2', 'risk: low', 'cost_effect: none', ...extra, '---', '', '## Acceptance criteria', '', '- [ ] x', ''].join('\n');
const verifyFile = (id, run = 'exit 0') => `${JSON.stringify({ order: id, checks: [{ name: 'the check', run, expect_exit: 0 }] }, null, 2)}\n`;

function project({ gitRepo = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aos-drafts-'));
  const a = join(root, '.analucia');
  for (const d of ['drafts', 'evidence']) mkdirSync(join(a, d), { recursive: true });
  writeFileSync(join(a, 'project.json'), `${JSON.stringify({ wip_limit: 2, locale: 'en' })}\n`);
  writeFileSync(logPath(root), '');
  writeFileSync(join(a, 'evidence', 'report.md'), '# report\n\n## Evidencia\n\nnone\n\nOUTCOME: done\n');
  if (gitRepo) {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.name', 't');
    git(root, 'config', 'user.email', 't@example.com');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');
  }
  return root;
}
const draft = (root, id, { md = order(id), json = verifyFile(id) } = {}) => {
  if (md !== null) writeFileSync(join(root, '.analucia', 'drafts', `${id}.md`), md);
  if (json !== null) writeFileSync(join(root, '.analucia', 'drafts', `${id}.request.md`), '- a point of the request => the draft'), writeFileSync(join(root, '.analucia', 'drafts', `${id}.json`), json);
};
const owner = (answers) => {
  const lines = [];
  const prompts = [];
  return { isTTY: true, push: false, lines, prompts, out: (s) => lines.push(s), ask: async (q) => { prompts.push(q); return answers.length ? answers.shift() : ''; } };
};
const stateOf = (root, id) => replay(readLog(root).events).orders[id]?.state;

test('drafts live in a path that is not protected; the protected paths stay protected', () => {
  assert.equal(isProtected('.analucia/drafts/ORD-0001.md'), false);
  assert.equal(isProtected('.analucia/drafts/ORD-0001.json'), false);
  assert.equal(isProtected('.analucia/DIRECTOR.md'), false);
  for (const p of ['.analucia/orders/ORD-0001.md', '.analucia/verify/ORD-0001.json', '.analucia/director.lock', '.analucia/HALT']) assert.equal(isProtected(p), true, p);
});

test('each draft is validated: the reason says what to change; aos drafts lists them and exits 1 while one is not ready', () => {
  const root = project();
  draft(root, 'ORD-0001');
  draft(root, 'ORD-0002', { json: null }); // no verify file
  draft(root, 'ORD-0003', { md: order('ORD-0003').replace('kind: fix', 'kind: nonsense') });
  draft(root, 'ORD-0004', { json: verifyFile('ORD-0004', 'git diff --quiet abc1234 HEAD -- src') }); // a moving ref
  draft(root, 'ORD-0005', { md: order('ORD-0005').replace('risk: low', 'risk: high') });
  draft(root, 'ORD-0006', { md: null }); // a verify file alone
  const by = Object.fromEntries(listDrafts(root).map((d) => [d.id, d]));
  assert.deepEqual(Object.keys(by), ['ORD-0001', 'ORD-0002', 'ORD-0003', 'ORD-0004', 'ORD-0005', 'ORD-0006']);
  assert.equal(by['ORD-0001'].ok, true);
  assert.equal(by['ORD-0001'].title, 'Title of ORD-0001');
  assert.match(by['ORD-0002'].problems.join('\n'), /an order needs its verify file: write \.analucia\/drafts\/ORD-0002\.json/);
  assert.match(by['ORD-0003'].problems.join('\n'), /E_KIND_ENUM/);
  assert.match(by['ORD-0004'].problems.join('\n'), /E_MOVING_REF/);
  assert.match(by['ORD-0005'].problems.join('\n'), /E_NO_ROLLBACK/);
  assert.match(by['ORD-0006'].problems.join('\n'), /the order file \.analucia\/drafts\/ORD-0006\.md is missing/);
  assert.equal(nextOrderId(root), 'ORD-0007');

  const r = aos(root, ['drafts']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /^ORD-0001: ready — Title of ORD-0001$/m);
  assert.match(r.stdout, /^ORD-0002: not ready\n {4}- E_FILE_MISSING an order needs its verify file/m);
  assert.match(r.stdout, /Next free ID: ORD-0007/);
  const none = aos(project(), ['drafts']);
  assert.equal(none.status, 0);
  assert.match(none.stdout, /No draft order is waiting\. Next free ID: ORD-0001\. Drafts go in \.analucia\/drafts\//);
});

test('nothing is placed without the typed confirmation, and an agent cannot give it', async () => {
  const root = project();
  draft(root, 'ORD-0001');
  // No terminal: refused before anything is read or written.
  const r = aos(root, ['sign'], 'PLACE\n');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /E_OWNER_TTY/);
  await assert.rejects(sign(root, { isTTY: false, ask: async () => 'PLACE' }), (x) => x.code === 'E_OWNER_TTY');
  // At the terminal, anything but PLACE leaves the draft where it is.
  for (const typed of ['', 'yes', 'place', 'CLOSE']) {
    const o = owner([typed]);
    const res = await sign(root, o);
    assert.deepEqual(res.placed, [], JSON.stringify(typed));
    assert.match(o.lines.join('\n'), /No draft was placed: the confirmation was not PLACE\./);
  }
  assert.ok(existsSync(join(root, '.analucia', 'drafts', 'ORD-0001.md')));
  for (const p of ['orders/ORD-0001.md', 'verify/ORD-0001.json', 'director.lock']) assert.equal(existsSync(join(root, '.analucia', p)), false, p);
  assert.equal(readLog(root).events.length, 0, 'nothing in the log');
});

test('PLACE: the valid draft is copied, hashed into a director.lock written by the tool, and admitted; the invalid one stays with its reason', async () => {
  const root = project();
  draft(root, 'ORD-0001');
  draft(root, 'ORD-0002', { json: null });
  const o = owner(['PLACE']);
  const res = await sign(root, o);
  assert.deepEqual(res.placed, ['ORD-0001']);
  assert.deepEqual(res.not_placed.map((x) => x.id), ['ORD-0002']);
  const text = o.lines.join('\n');
  assert.match(text, /Draft orders waiting to be placed \(2\):\n {2}ORD-0001: Title of ORD-0001 — valid, ready to place\n {2}ORD-0002: not valid, it stays a draft\. Reason:\n {6}- E_FILE_MISSING an order needs its verify file/);
  assert.match(o.prompts[0], /^Type PLACE to place ORD-0001 /);
  assert.match(text, /Placed and queued: ORD-0001\. The executor can start\./);
  assert.match(text, /Placement saved in git \([0-9a-f]{7,}\)\./);

  // Placed: the files, the lock, the record, the state.
  const lockText = readFileSync(join(root, '.analucia', 'director.lock'), 'utf8');
  assert.deepEqual(validateLockText(lockText), [], 'the lock validates');
  const lock = readLock(root);
  assert.equal(lock.written_by, 'director');
  assert.equal(lock.normalization, 'LF');
  assert.deepEqual(Object.keys(lock.files).sort(), ['.analucia/orders/ORD-0001.md', '.analucia/verify/ORD-0001.json']);
  for (const [p, h] of Object.entries(lock.files)) assert.equal(hashLF(readFileSync(join(root, p))), h, p);
  assert.deepEqual(checkLock(root), []);
  assert.equal(stateOf(root, 'ORD-0001'), 'queued');
  const events = readLog(root).events;
  assert.deepEqual(events.map((e) => `${e.type}:${e.actor}`), ['record.created:director', 'order.state_changed:director', 'order.state_changed:director', 'operation.logged:owner']);
  assert.ok(events[0].payload.pins.plugin, 'admitted with pins');
  assert.deepEqual(events[3].payload, { operation: 'drafts_placed', orders: ['ORD-0001'] });
  assert.equal(verifyChain(readFileSync(logPath(root))), null);
  // The draft left the drafts folder; the invalid one is still there.
  assert.equal(existsSync(join(root, '.analucia', 'drafts', 'ORD-0001.md')), false);
  assert.equal(existsSync(join(root, '.analucia', 'drafts', 'ORD-0001.json')), false);
  assert.ok(existsSync(join(root, '.analucia', 'drafts', 'ORD-0002.md')));
  assert.equal(stateOf(root, 'ORD-0002'), undefined);
  // The placement is one commit of director paths, which needs no order trailer.
  assert.match(git(root, 'log', '-1', '--format=%s').stdout.trim(), /^Director: ORD-0001 placed \(owner confirmed, aos sign\)$/);
  assert.deepEqual(git(root, 'show', '--name-only', '--format=', 'HEAD').stdout.trim().split('\n').sort(), ['.analucia/director.lock', '.analucia/events.jsonl', '.analucia/orders/ORD-0001.md', '.analucia/verify/ORD-0001.json']);
  assert.equal(aos(root, ['validate']).status, 0, 'aos validate');
  assert.equal(aos(root, ['run', 'start', 'ORD-0001']).status, 0, 'the executor can start it');

  // A later placement keeps the entries of the first one.
  draft(root, 'ORD-0002');
  const again = await sign(root, owner(['PLACE']));
  assert.deepEqual(again.placed, ['ORD-0002']);
  assert.equal(Object.keys(readLock(root).files).length, 4);
  assert.deepEqual(checkLock(root), []);
  // A draft that reuses a placed ID is refused with the reason.
  draft(root, 'ORD-0001');
  assert.match(listDrafts(root)[0].problems.join('\n'), /E_RECORD_EXISTS ORD-0001 already exists as a placed order: give the draft a new ID/);
});

test('aos sign shows the drafts before the orders to verify, and both can be confirmed in one sitting', async () => {
  const root = project();
  draft(root, 'ORD-0001');
  await sign(root, owner(['PLACE']));
  assert.equal(aos(root, ['run', 'start', 'ORD-0001']).status, 0);
  assert.equal(aos(root, ['run', 'finish', 'ORD-0001', '--outcome', 'done', '--evidence', '.analucia/evidence/report.md']).status, 0);
  draft(root, 'ORD-0002');
  const o = owner(['PLACE', 'CLOSE']);
  const res = await sign(root, o);
  const text = o.lines.join('\n');
  assert.ok(text.indexOf('Draft orders waiting to be placed') > -1 && text.indexOf('Draft orders waiting to be placed') < text.indexOf('Checking ORD-0001'), 'drafts first');
  assert.deepEqual(res.placed, ['ORD-0002']);
  assert.deepEqual(res.signed, ['ORD-0001']);
  assert.equal(stateOf(root, 'ORD-0001'), 'closed');
  assert.equal(stateOf(root, 'ORD-0002'), 'queued');
});

test('without git the placement is recorded in the log and the files all the same', async () => {
  const root = project({ gitRepo: false });
  draft(root, 'ORD-0001');
  const res = await sign(root, owner(['PLACE']));
  assert.deepEqual(res.placed, ['ORD-0001']);
  assert.equal(stateOf(root, 'ORD-0001'), 'queued');
  assert.deepEqual(checkLock(root), []);
});
