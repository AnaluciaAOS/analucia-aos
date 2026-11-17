// ORD-0041 part 1 (AMD-0015 §1, §8): a numbering that names the project. project.json carries project_code (2 to 5
// capital letters, never a type word, unique on the computer). New records carry it: <CODE>-NNNN, <CODE>-AMD-NNNN,
// <CODE>-ASK-NNNN, each counter continuing from the highest number the project already has. Nothing existing is
// renumbered: every old ID stays valid, and a new record with the old prefix is refused with the ID to use.
// Every trial runs in scratch folders with a scratch CLAUDE_CONFIG_DIR: the owner's configuration is never touched.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CONFIG = mkdtempSync(join(tmpdir(), 'aos-code-cfg-'));
// Test files may share one process: every test that reaches the list of codes points at this scratch folder first.
const useScratchConfig = () => { process.env.CLAUDE_CONFIG_DIR = CONFIG; };
useScratchConfig();
delete process.env.CLAUDE_PROJECT_DIR;

const { TYPE_WORDS, codeProblem, codesPath, idsMap, isAmendmentId, isAskId, isOrderId, nextId, parseId, projectCode, readCodes } = await import('../lib/ids.mjs');
const { listDrafts, nextOrderId } = await import('../lib/drafts.mjs');
const { hashLF, checkLock } = await import('../lib/lock.mjs');
const { appendEvent, logPath, readLog } = await import('../lib/log.mjs');
const { nextLine } = await import('../lib/next.mjs');
const { onboardingStarted, runInit } = await import('../lib/onboarding.mjs');
const { nextActionBy } = await import('../lib/owner-sheet.mjs');
const { sign } = await import('../lib/sign.mjs');
const { replay } = await import('../lib/state.mjs');
const { wizard, WIZARD } = await import('../lib/wizard.mjs');

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
const aos = (root, args, input = '') => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input, env });
const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' });

const order = (id, extra = []) => ['---', `id: ${id}`, `title: Title of ${id}`, 'kind: fix', 'created: 2026-11-14', 'budget_max_minutes: 30', 'budget_max_attempts: 2', 'risk: low', 'cost_effect: none', ...extra, '---', '', '## Acceptance criteria', '', '- [ ] x', ''].join('\n');
const verifyFile = (id, run = 'exit 0') => `${JSON.stringify({ order: id, checks: [{ name: 'the check', run, expect_exit: 0 }] }, null, 2)}\n`;
const ask = (id) => ['---', `id: ${id}`, 'title: Which colour', 'kind: decide', 'created: 2026-11-14', 'recommendation: approve', '---', '', 'Blue or green?', ''].join('\n');

// A project with `old` placed and queued orders under the old prefix, then (optionally) given a code.
function project({ code, old = [], gitRepo = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aos-code-'));
  const a = join(root, '.analucia');
  for (const d of ['orders', 'verify', 'drafts', 'evidence', 'amendments', 'asks']) mkdirSync(join(a, d), { recursive: true });
  writeFileSync(join(a, 'project.json'), `${JSON.stringify({ wip_limit: 3, locale: 'en' })}\n`);
  writeFileSync(logPath(root), '');
  writeFileSync(join(a, 'evidence', 'report.md'), '# r\n\n## Evidencia\n\nx\n\nOUTCOME: done\n');
  const files = {};
  for (const id of old) {
    writeFileSync(join(a, 'orders', `${id}.md`), order(id));
    writeFileSync(join(a, 'verify', `${id}.json`), verifyFile(id));
    for (const rel of [`.analucia/orders/${id}.md`, `.analucia/verify/${id}.json`]) files[rel] = hashLF(readFileSync(join(root, rel)));
    appendEvent(root, { type: 'record.created', actor: 'director', subject: id });
    appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: id, payload: { from: 'draft', to: 'ready' } });
    appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: id, payload: { from: 'ready', to: 'queued' } });
  }
  if (old.length) writeFileSync(join(a, 'director.lock'), JSON.stringify({ files }));
  if (code) setCode(root, code);
  if (gitRepo) {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.name', 't');
    git(root, 'config', 'user.email', 't@example.com');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');
  }
  return root;
}
const setCode = (root, code) => {
  const p = join(root, '.analucia', 'project.json');
  writeFileSync(p, `${JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf8')), project_code: code })}\n`);
};
const draft = (root, id, { md = order(id), json = verifyFile(id) } = {}) => {
  if (md !== null) writeFileSync(join(root, '.analucia', 'drafts', `${id}.md`), md);
  if (json !== null) writeFileSync(join(root, '.analucia', 'drafts', `${id}.json`), json);
};
const owner = (answers) => {
  const lines = [];
  const prompts = [];
  return { isTTY: true, push: false, lines, prompts, out: (s) => lines.push(s), ask: async (q) => { prompts.push(q); return answers.length ? answers.shift() : ''; } };
};
const stateOf = (root, id) => replay(readLog(root).events).orders[id]?.state;
const ANSWERS = { purpose: 'A scratch project', github_owner: 'none', owner_locale: 'en' };
const init = async (root, provided, { answer = 'CONFIRM', dryRun = false } = {}) => {
  const lines = [];
  const r = await runInit(root, { provided: { ...ANSWERS, ...provided }, locale: 'en', dryRun, isTTY: true, ask: async () => answer, out: (s) => lines.push(s), onConfirmed: () => { if (!existsSync(logPath(root))) onboardingStarted(root); } });
  return { ...r, text: lines.join('\n') };
};

test('the code: 2 to 5 capital letters, never a type word', () => {
  for (const ok of ['AB', 'TST', 'SHOP', 'ABCDE']) assert.equal(codeProblem(ok), null, ok);
  for (const bad of ['', 'A', 'ABCDEF', 'tst', 'T1T', 'AB-C', ' TST', 'Tst']) assert.ok(codeProblem(bad), JSON.stringify(bad));
  assert.deepEqual(TYPE_WORDS, ['ORD', 'AMD', 'ASK', 'DEC', 'OBS', 'SPEC']);
  for (const word of TYPE_WORDS) assert.match(codeProblem(word), /type word/, word);
});

test('IDs: both forms are read, kind by kind', () => {
  assert.deepEqual(parseId('ORD-0041'), { kind: 'order', code: null, number: 41, phase: null });
  assert.deepEqual(parseId('ORD-0041.B'), { kind: 'order', code: null, number: 41, phase: 'B' });
  assert.deepEqual(parseId('TST-0007'), { kind: 'order', code: 'TST', number: 7, phase: null });
  assert.deepEqual(parseId('TST-0007.A'), { kind: 'order', code: 'TST', number: 7, phase: 'A' });
  assert.deepEqual(parseId('AMD-0015'), { kind: 'amendment', code: null, number: 15, phase: null });
  assert.deepEqual(parseId('TST-AMD-0016'), { kind: 'amendment', code: 'TST', number: 16, phase: null });
  assert.deepEqual(parseId('ASK-0002'), { kind: 'ask', code: null, number: 2, phase: null });
  assert.deepEqual(parseId('TST-ASK-0003'), { kind: 'ask', code: 'TST', number: 3, phase: null });
  assert.equal(parseId('SPEC-0001').kind, 'spec');
  for (const bad of ['TST-1', 'tst-0001', 'TST-00001', 'ORD-AMD-0001', 'TST-DEC-0001', 'TOOLONG-0001', 'T-0001', 'TST-ASK-0001.A', 'AMD-0001.A']) assert.equal(parseId(bad), null, bad);
  assert.ok(isOrderId('ORD-0001') && isOrderId('TST-0001') && !isOrderId('AMD-0001') && !isOrderId('TST-AMD-0001') && !isOrderId('ASK-0001'));
  assert.ok(isAskId('ASK-0001') && isAskId('TST-ASK-0001') && !isAskId('TST-0001'));
  assert.ok(isAmendmentId('AMD-0001') && isAmendmentId('TST-AMD-0001') && !isAmendmentId('TST-0001'));
});

test('aos validate: IDs with the project code validate; a foreign prefix, a type word as code and a new old-prefix record do not', () => {
  const run = (root) => aos(root, ['validate']);
  // No code: the old form, as before; a coded ID has no project to belong to.
  const plain = project();
  writeFileSync(join(plain, '.analucia', 'orders', 'ORD-0001.md'), order('ORD-0001'));
  assert.equal(run(plain).status, 0, run(plain).stdout);
  writeFileSync(join(plain, '.analucia', 'orders', 'TST-0002.md'), order('TST-0002'));
  assert.equal(run(plain).status, 1);
  assert.match(run(plain).stdout, /orders\/TST-0002\.md:\d+: E_ID_PREFIX/);
  // A code: its own IDs validate, another prefix does not.
  const coded = project({ code: 'TST' });
  writeFileSync(join(coded, '.analucia', 'orders', 'TST-0001.md'), order('TST-0001'));
  writeFileSync(join(coded, '.analucia', 'verify', 'TST-0001.json'), verifyFile('TST-0001'));
  writeFileSync(join(coded, '.analucia', 'asks', 'TST-ASK-0001.md'), ask('TST-ASK-0001'));
  assert.equal(run(coded).status, 0, run(coded).stdout);
  writeFileSync(join(coded, '.analucia', 'orders', 'ZZZ-0002.md'), order('ZZZ-0002'));
  assert.equal(run(coded).status, 1);
  assert.match(run(coded).stdout, /orders\/ZZZ-0002\.md:\d+: E_ID_PREFIX .*TST/);
  // Existing records keep their old IDs for ever; a new file with the old prefix is refused with the ID to use.
  const adopted = project({ old: ['ORD-0001', 'ORD-0002'], code: 'TST' });
  assert.equal(run(adopted).status, 0, run(adopted).stdout);
  writeFileSync(join(adopted, '.analucia', 'orders', 'ORD-0003.md'), order('ORD-0003'));
  assert.equal(run(adopted).status, 1);
  assert.match(run(adopted).stdout, /orders\/ORD-0003\.md:\d+: E_ID_PREFIX .*TST-0003/);
  // project.json: the code itself.
  for (const bad of ['ORD', 'SPEC', 'tst', 'TOOLONG', 'A']) {
    const p = project();
    setCode(p, bad);
    assert.equal(run(p).status, 1, bad);
    assert.match(run(p).stdout, /project\.json:\d+: E_FIELD_TYPE "project_code"/, bad);
  }
});

test('counters continue from the highest number the project has, per kind; they never restart', () => {
  const root = project({ old: ['ORD-0001', 'ORD-0002', 'ORD-0007'] });
  writeFileSync(join(root, '.analucia', 'amendments', 'AMD-0001.md'), 'x\n');
  writeFileSync(join(root, '.analucia', 'amendments', 'AMD-0004.md'), 'x\n');
  writeFileSync(join(root, '.analucia', 'asks', 'ASK-0002.md'), ask('ASK-0002'));
  assert.deepEqual([nextId(root, 'order'), nextId(root, 'amendment'), nextId(root, 'ask')], ['ORD-0008', 'AMD-0005', 'ASK-0003']);
  assert.equal(projectCode(root), null);
  setCode(root, 'TST');
  assert.equal(projectCode(root), 'TST');
  assert.deepEqual([nextId(root, 'order'), nextId(root, 'amendment'), nextId(root, 'ask')], ['TST-0008', 'TST-AMD-0005', 'TST-ASK-0003']);
  assert.equal(nextOrderId(root), 'TST-0008');
  // A draft and a coded record count too.
  draft(root, 'TST-0008');
  writeFileSync(join(root, '.analucia', 'amendments', 'TST-AMD-0005.md'), 'x\n');
  assert.deepEqual([nextId(root, 'order'), nextId(root, 'amendment')], ['TST-0009', 'TST-AMD-0006']);
});

test('a new record with the old prefix is refused once the project has a code: drafts, admit, ask open and the log writer', async () => {
  const root = project({ old: ['ORD-0001'], code: 'TST', gitRepo: true });
  // Draft with the old prefix: the reason gives the ID to use.
  draft(root, 'ORD-0002');
  const d = listDrafts(root)[0];
  assert.equal(d.ok, false);
  assert.match(d.problems.join('\n'), /E_ID_PREFIX .*use TST-0002/);
  assert.match(aos(root, ['drafts']).stdout, /Next free ID: TST-0002/);
  assert.deepEqual((await sign(root, owner(['PLACE']))).placed, []);
  rmSync(join(root, '.analucia', 'drafts', 'ORD-0002.md'));
  rmSync(join(root, '.analucia', 'drafts', 'ORD-0002.json'));
  // The single writer of the log refuses the record whoever asks.
  const before = readFileSync(logPath(root), 'utf8');
  const r = aos(root, ['event', 'append', '--type', 'record.created', '--actor', 'director', '--subject', 'ORD-0002']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /E_ID_PREFIX .*TST-0002/);
  assert.match(r.stdout, /next \(director\)/);
  const foreign = aos(root, ['event', 'append', '--type', 'record.created', '--actor', 'director', '--subject', 'ZZZ-0002']);
  assert.match(foreign.stdout, /E_ID_PREFIX/);
  const oldAsk = aos(root, ['event', 'append', '--type', 'record.created', '--actor', 'director', '--subject', 'ASK-0001']);
  assert.match(oldAsk.stdout, /E_ID_PREFIX .*TST-ASK-0001/);
  assert.equal(readFileSync(logPath(root), 'utf8'), before, 'nothing written');
  // The existing old record keeps working: it can still be run.
  assert.equal(aos(root, ['run', 'start', 'ORD-0001']).status, 0);
  assert.equal(aos(root, ['run', 'finish', 'ORD-0001', '--outcome', 'done', '--evidence', '.analucia/evidence/report.md']).status, 0);
  assert.equal(stateOf(root, 'ORD-0001'), 'delivered');
  // In a project without a code nothing changes: the old prefix is the only one, a coded record is refused.
  const plain = project();
  assert.equal(aos(plain, ['event', 'append', '--type', 'record.created', '--actor', 'director', '--subject', 'ORD-0001']).status, 0);
  assert.match(aos(plain, ['event', 'append', '--type', 'record.created', '--actor', 'director', '--subject', 'TST-0002']).stdout, /E_ID_PREFIX/);
});

test('a coded order goes the whole way: draft, placed, run, trailer, push guard, verify with {order_commit}, signed', async () => {
  const root = project({ old: ['ORD-0001'], code: 'TST', gitRepo: true });
  const bare = mkdtempSync(join(tmpdir(), 'aos-code-bare-'));
  git(bare, 'init', '-q', '--bare');
  git(root, 'remote', 'add', 'origin', bare);
  git(root, 'push', '-q', '--no-verify', '-u', 'origin', 'main');
  const id = 'TST-0002';
  draft(root, id, { json: verifyFile(id, 'git cat-file -e {order_commit}^{commit} && test -s work.txt') });
  assert.equal(listDrafts(root)[0].ok, true, listDrafts(root)[0].problems.join('\n'));
  assert.deepEqual((await sign(root, owner(['PLACE']))).placed, [id]);
  for (const rel of [`.analucia/orders/${id}.md`, `.analucia/verify/${id}.json`]) assert.ok(existsSync(join(root, rel)), rel);
  assert.deepEqual(checkLock(root), []);
  assert.equal(stateOf(root, id), 'queued');
  assert.equal(nextLine(root, { explicit: true, locale: 'en' }).includes(`run start ${id}`) || nextLine(root, { explicit: true, locale: 'en' }).includes('run start ORD-0001'), true);
  assert.equal(aos(root, ['run', 'start', id]).status, 0);
  writeFileSync(join(root, 'work.txt'), 'done\n');
  mkdirSync(join(root, '.analucia', 'evidence', id), { recursive: true });
  writeFileSync(join(root, '.analucia', 'evidence', id, 'report.md'), '# r\n\n## Evidencia\n\nx\n\nOUTCOME: done\n');
  git(root, 'add', 'work.txt');
  git(root, 'commit', '-q', '-m', `work\n\nAnalucia-Order: ${id}`);
  // The push guard reads the trailer in the new form (the account part is not under test here).
  const { orderTrailers } = await import('../lib/guards.mjs');
  assert.deepEqual(orderTrailers(`x\n\nAnalucia-Order: ${id}\n`), [id]);
  assert.equal(aos(root, ['run', 'finish', id, '--outcome', 'done', '--evidence', `.analucia/evidence/${id}/report.md`]).status, 0);
  const o = owner(['CLOSE']);
  const res = await sign(root, o);
  assert.deepEqual(res.signed, [id], o.lines.join('\n'));
  assert.equal(stateOf(root, id), 'closed');
  assert.match(git(root, 'log', '-1', '--format=%B').stdout, new RegExp(`Analucia-Order: ${id}`));
  assert.ok(existsSync(join(root, '.analucia', 'evidence', id, 'verify-01.txt')));
  assert.equal(aos(root, ['validate']).status, 0, aos(root, ['validate']).stdout);
  assert.equal(aos(root, ['verify-log']).status, 0);
  assert.match(aos(root, ['history', id]).stdout, /verified -> closed/);
  assert.equal(aos(root, ['derive']).status, 0);
  assert.match(readFileSync(join(root, '.analucia', 'views', 'queue.md'), 'utf8'), /ORD-0001/);
});

test('asks carry the code too, and an order blocked by one waits for the owner', () => {
  const root = project({ old: ['ORD-0001'], code: 'TST' });
  const id = 'TST-ASK-0001';
  writeFileSync(join(root, '.analucia', 'asks', `${id}.md`), ask(id));
  const lock = JSON.parse(readFileSync(join(root, '.analucia', 'director.lock'), 'utf8'));
  lock.files[`.analucia/asks/${id}.md`] = hashLF(readFileSync(join(root, '.analucia', 'asks', `${id}.md`)));
  writeFileSync(join(root, '.analucia', 'director.lock'), JSON.stringify(lock));
  const opened = aos(root, ['ask', 'open', id]);
  assert.equal(opened.status, 0, opened.stderr);
  assert.equal(replay(readLog(root).events).asks[id].status, 'open');
  assert.equal(nextActionBy({ state: 'blocked', blocked_by: id }), 'owner');
  assert.equal(nextActionBy({ state: 'blocked', blocked_by: 'ASK-0001' }), 'owner');
  assert.equal(nextActionBy({ state: 'blocked', blocked_by: 'a reason' }), 'director');
  assert.equal(aos(root, ['validate']).status, 0, aos(root, ['validate']).stdout);
  const export1 = aos(root, ['ceo', 'export', '--out', join(root, 'sheet.xlsx')]);
  assert.equal(export1.status, 0, export1.stderr);
  assert.match(export1.stdout, /1 asks, 1 orders/);
});

test('aos ids: one line without a code; with one, every record with its number under the code and the next free IDs', () => {
  const plain = project({ old: ['ORD-0001'] });
  const a = aos(plain, ['ids']);
  assert.equal(a.status, 0);
  assert.equal(a.stdout.trimEnd().split('\n').length, 1, a.stdout);
  assert.match(a.stdout, /no project code yet/i);
  const root = project({ old: ['ORD-0001', 'ORD-0002'], code: 'TST' });
  writeFileSync(join(root, '.analucia', 'amendments', 'AMD-0001.md'), 'x\n');
  draft(root, 'TST-0003');
  const map = idsMap(root);
  assert.equal(map.code, 'TST');
  assert.deepEqual(map.records.map((r) => [r.id, r.under_code]), [['ORD-0001', 'TST-0001'], ['ORD-0002', 'TST-0002'], ['AMD-0001', 'TST-AMD-0001']]);
  assert.deepEqual(map.next, { order: 'TST-0004', amendment: 'TST-AMD-0002', ask: 'TST-ASK-0001' });
  const b = aos(root, ['ids']);
  assert.equal(b.status, 0);
  assert.match(b.stdout, /^ORD-0001 {2}= {2}TST-0001/m);
  assert.match(b.stdout, /^AMD-0001 {2}= {2}TST-AMD-0001/m);
  assert.match(b.stdout, /TST-0004/);
  assert.match(b.stdout, /TST-AMD-0002/);
  assert.match(b.stdout, /TST-ASK-0001/);
  // The map is for reading: no file was renamed and the log is as it was.
  assert.ok(existsSync(join(root, '.analucia', 'orders', 'ORD-0001.md')));
  assert.equal(existsSync(join(root, '.analucia', 'orders', 'TST-0001.md')), false);
});

test('aos init: the code is one more answer, written to project.json and registered; unique on the computer', async () => {
  useScratchConfig();
  const one = mkdtempSync(join(tmpdir(), 'aos-code-init-'));
  const dry = await init(one, { project_code: 'TST' }, { dryRun: true });
  assert.match(dry.text, /project_code: TST/);
  assert.equal(existsSync(codesPath()), false, `a dry run registers nothing (${codesPath()}: ${existsSync(codesPath()) ? readFileSync(codesPath(), 'utf8') : ''})`);
  await init(one, { project_code: 'TST' });
  assert.equal(JSON.parse(readFileSync(join(one, '.analucia', 'project.json'), 'utf8')).project_code, 'TST');
  assert.ok(codesPath().startsWith(CONFIG), 'the list lives in the configuration folder (CLAUDE_CONFIG_DIR)');
  assert.deepEqual(Object.keys(readCodes()), ['TST']);
  assert.equal(aos(one, ['validate']).status, 0, aos(one, ['validate']).stdout);
  // The same project again: nothing changes.
  const again = await init(one, { project_code: 'TST' });
  assert.deepEqual(again.items.filter((i) => !['unchanged', 'skipped'].includes(i.status)).map((i) => i.item), []);
  // Another project asks for the same code: refused, naming the folder that has it; nothing is written there.
  const two = mkdtempSync(join(tmpdir(), 'aos-code-init-'));
  await assert.rejects(init(two, { project_code: 'TST' }), (x) => x.code === 'E_CODE_TAKEN' && x.message.includes(one.split('\\').join('/')));
  assert.equal(existsSync(join(two, '.analucia', 'project.json')), false);
  await init(two, { project_code: 'TWO' });
  assert.deepEqual(Object.keys(readCodes()).sort(), ['TST', 'TWO']);
  // A type word, or a malformed code: refused as an answer.
  const three = mkdtempSync(join(tmpdir(), 'aos-code-init-'));
  for (const bad of ['ORD', 'ask', 'TOOLONG']) await assert.rejects(init(three, { project_code: bad }), (x) => x.code === 'E_ANSWER_VALUE', bad);
  // No code given: the project works as before, without one.
  await init(three, {});
  assert.equal('project_code' in JSON.parse(readFileSync(join(three, '.analucia', 'project.json'), 'utf8')), false);
  // A registered folder that no longer exists does not keep its code for ever.
  rmSync(two, { recursive: true, force: true });
  await init(three, { project_code: 'TWO' });
  assert.equal(JSON.parse(readFileSync(join(three, '.analucia', 'project.json'), 'utf8')).project_code, 'TWO');
  // A code already used by records is not changed by a later answer.
  await assert.rejects(init(one, { project_code: 'NEW' }), (x) => x.code === 'E_ANSWER_VALUE' && /already has the code TST/.test(x.message));
});

test('the wizard asks the code after its 15 questions; in a project already initialised without a code it asks only that', async () => {
  useScratchConfig();
  const fresh = mkdtempSync(join(tmpdir(), 'aos-code-wiz-'));
  const numbers = WIZARD.map((q) => (q.key === 'github_owner' ? '2' : '1'));
  const first = owner([...numbers, '', 'ord', 'WIZ']);
  const a = await wizard(fresh, { locale: 'en', ask: first.ask, out: first.out });
  assert.equal(a.provided.project_code, 'WIZ');
  assert.equal(first.prompts.length, 15 + 1 + 2, 'the 15 questions, the summary, the code asked twice (a type word first)');
  assert.match(first.prompts.at(-1), /2 to 5 capital letters/);
  assert.match(first.lines.join('\n'), /type word/);
  // Enter: no code for now, said in one line.
  const skip = owner([...numbers, '', '']);
  const b = await wizard(mkdtempSync(join(tmpdir(), 'aos-code-wiz-')), { locale: 'en', ask: skip.ask, out: skip.out });
  assert.equal('project_code' in b.provided, false);
  // Already initialised, no code: only the code is asked.
  const old = mkdtempSync(join(tmpdir(), 'aos-code-wiz-'));
  await init(old, {});
  const only = owner(['OLD']);
  const c = await wizard(old, { locale: 'en', ask: only.ask, out: only.out });
  assert.deepEqual(c.provided, { project_code: 'OLD' });
  assert.equal(only.prompts.length, 1);
  // Already initialised with a code: the 15 questions as before, and the code is not asked again.
  await init(old, { project_code: 'OLD' });
  const later = owner([...Array(15).fill(''), '']);
  const d = await wizard(old, { locale: 'en', ask: later.ask, out: later.out });
  assert.equal(later.prompts.length, 16);
  assert.equal('project_code' in d.provided, false);
});

test('the bootstrap order offered by aos init carries the code', async () => {
  useScratchConfig();
  const root = mkdtempSync(join(tmpdir(), 'aos-code-boot-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 't');
  git(root, 'config', 'user.email', 't@example.com');
  writeFileSync(join(root, 'README.md'), '# x\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'before the Loop');
  await init(root, { project_code: 'BOOT' });
  const drafts = listDrafts(root);
  assert.deepEqual(drafts.map((d) => [d.id, d.ok, d.problems]), [['BOOT-0001', true, []]]);
  const text = readFileSync(join(root, '.analucia', 'drafts', 'BOOT-0001.md'), 'utf8') + readFileSync(join(root, '.analucia', 'drafts', 'BOOT-0001.json'), 'utf8');
  assert.doesNotMatch(text, /ORD-0001/);
  assert.match(text, /Analucia-Order: BOOT-0001/);
});
