// ORD-0043 part 2 (OBS-167): a check of the verify file may carry "class": "form". `aos verify` runs every check as
// before and reports the failed ones in two groups. `aos sign` offers a waiver only to the owner and only when every
// failed check of a delivered order is of class form: a typed word and a written reason of at least ten characters
// for each. The waivers are recorded in the payload of owner.signed and written into the verify evidence, marked
// WAIVED. A check of substance is never waived, and `aos validate` refuses the class form on the checks that are
// substance by nature.
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
import { validateVerifyText } from '../lib/validate.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
delete env.CLAUDE_PROJECT_DIR;
delete env.CLAUDE_CODE_SESSION_ID;
const aos = (root, args, input = '') => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input, env });
const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' });

const FORM = { name: 'the label of the report', run: 'exit 1', expect_exit: 0, class: 'form' };
const FORM_2 = { name: 'the name of the branch', run: 'exit 3', expect_exit: 0, class: 'form' };
const SUBSTANCE = { name: 'the work', run: 'exit 1', expect_exit: 0 };
const PASSING = { name: 'it exists', run: 'exit 0', expect_exit: 0 };

// One delivered order with the given checks, in a git repository (no remote: nothing is pushed).
function delivered(checks) {
  const root = mkdtempSync(join(tmpdir(), 'aos-waive-'));
  const a = join(root, '.analucia');
  for (const d of ['orders', 'verify', 'evidence']) mkdirSync(join(a, d), { recursive: true });
  writeFileSync(join(a, 'project.json'), '{"wip_limit":3,"locale":"en"}\n');
  writeFileSync(logPath(root), '');
  writeFileSync(join(a, 'evidence', 'report.md'), '# r\n\n## Evidencia\n\nx\n\nOUTCOME: done\n');
  const id = 'ORD-0001';
  writeFileSync(join(a, 'orders', `${id}.md`), ['---', `id: ${id}`, 'title: T', 'kind: fix', 'created: 2026-11-16', 'budget_max_minutes: 30', 'budget_max_attempts: 2', '---', '', '## Acceptance criteria', '', '- [ ] x', ''].join('\n'));
  writeFileSync(join(a, 'verify', `${id}.json`), JSON.stringify({ order: id, checks }));
  const files = {};
  for (const rel of [`.analucia/orders/${id}.md`, `.analucia/verify/${id}.json`]) files[rel] = hashLF(readFileSync(join(root, rel)));
  writeFileSync(join(a, 'director.lock'), JSON.stringify({ files }));
  appendEvent(root, { type: 'record.created', actor: 'director', subject: id });
  appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: id, payload: { from: 'draft', to: 'ready' } });
  appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: id, payload: { from: 'ready', to: 'queued' } });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  assert.equal(aos(root, ['run', 'start', id]).status, 0);
  assert.equal(aos(root, ['run', 'finish', id, '--outcome', 'done', '--evidence', '.analucia/evidence/report.md']).status, 0);
  return root;
}
// The owner at the terminal: answers by the kind of question, and keeps what was asked and printed.
function owner({ word = 'WAIVE', reason = 'three report-only commits, no code in them', close = 'CLOSE' } = {}) {
  const asked = [];
  const lines = [];
  const ask = async (q) => {
    asked.push(q);
    if (/WAIVE/.test(q)) return word;
    if (/Reason/.test(q)) return reason;
    return close;
  };
  return { asked, lines, opts: { isTTY: true, ask, out: (s) => lines.push(s), push: false } };
}
const stateOf = (root) => replay(readLog(root).events).orders['ORD-0001'].state;
const waiveQuestions = (o) => o.asked.filter((q) => /WAIVE/.test(q)).length;

test('a failed check of form is waived by the owner with a reason: recorded in owner.signed and in the verify evidence, and the order closes', async () => {
  const root = delivered([PASSING, FORM, FORM_2]);
  const o = owner();
  const r = await sign(root, o.opts);
  assert.deepEqual(r.signed, ['ORD-0001']);
  assert.equal(stateOf(root), 'closed');
  // Each failed check was shown with its name, its command and its exit code, and asked for on its own.
  const text = o.lines.join('\n');
  assert.match(text, /the label of the report/);
  assert.match(text, /command: exit 1/);
  assert.match(text, /exit 1 \(expected 0\)/);
  assert.match(text, /command: exit 3/);
  assert.equal(waiveQuestions(o), 2);
  assert.equal(o.asked.filter((q) => /Reason/.test(q)).length, 2);
  // The record: the payload of the sign-off event that already exists.
  const events = readLog(root).events;
  const signed = events.filter((e) => e.type === 'owner.signed').at(-1);
  assert.deepEqual(signed.payload.waived, [
    { order: 'ORD-0001', check: 'the label of the report', reason: 'three report-only commits, no code in them' },
    { order: 'ORD-0001', check: 'the name of the branch', reason: 'three report-only commits, no code in them' },
  ]);
  assert.deepEqual(signed.payload.orders, ['ORD-0001']);
  // No new event type; "verified" is still entered by the system, with what was waived.
  const verified = events.find((e) => e.type === 'order.state_changed' && e.payload.to === 'verified');
  assert.equal(verified.actor, 'system');
  assert.deepEqual(verified.payload.waived, ['the label of the report', 'the name of the branch']);
  // The verify evidence carries the waivers, marked WAIVED, with their reasons.
  const evidence = readFileSync(join(root, verified.payload.evidence), 'utf8');
  assert.match(evidence, /^WAIVED: the label of the report — reason: three report-only commits, no code in them$/m);
  assert.match(evidence, /^WAIVED: the name of the branch — /m);
  // aos status <ID> and the queue view show it.
  assert.match(aos(root, ['status', 'ORD-0001']).stdout, /waived: 2/);
  assert.equal(aos(root, ['derive']).status, 0);
  assert.match(readFileSync(join(root, '.analucia', 'views', 'queue.md'), 'utf8'), /ORD-0001.*waived: 2/);
});

test('a failed check of substance is never offered; neither is a mix of substance and form', async () => {
  for (const checks of [[PASSING, SUBSTANCE], [SUBSTANCE, FORM]]) {
    const root = delivered(checks);
    const o = owner();
    const r = await sign(root, o.opts);
    assert.deepEqual([r.signed, r.failed], [[], ['ORD-0001']]);
    assert.equal(waiveQuestions(o), 0, 'no waiver is offered');
    assert.equal(o.asked.length, 0, 'nothing passed: not even CLOSE is asked');
    assert.equal(stateOf(root), 'delivered');
    assert.equal(readLog(root).events.some((e) => e.type === 'owner.signed'), false);
  }
  // The mix says which group each failed check belongs to.
  const root = delivered([SUBSTANCE, FORM]);
  const o = owner();
  await sign(root, o.opts);
  assert.match(o.lines.join('\n'), /substance: the work; form: the label of the report/);
});

test('without the word, or without a reason of ten characters, nothing is waived and nothing is recorded', async () => {
  for (const answers of [{ reason: 'too short' }, { reason: '          ' }, { word: 'yes' }, { word: 'waive' }]) {
    const root = delivered([FORM]);
    const o = owner(answers);
    const r = await sign(root, o.opts);
    assert.deepEqual([r.signed, r.failed], [[], ['ORD-0001']], JSON.stringify(answers));
    assert.equal(stateOf(root), 'delivered');
    const events = readLog(root).events;
    assert.equal(events.some((e) => e.type === 'owner.signed' || e.payload?.to === 'verified'), false);
    assert.doesNotMatch(readFileSync(join(root, '.analucia', 'evidence', 'ORD-0001', 'verify-01.txt'), 'utf8'), /WAIVED/);
  }
  // Waived but not signed: the owner did not type CLOSE, so the waiver is not recorded either.
  const root = delivered([FORM]);
  await assert.rejects(sign(root, owner({ close: 'no' }).opts), (x) => x.code === 'E_NOT_CONFIRMED');
  assert.equal(stateOf(root), 'delivered');
  assert.equal(readLog(root).events.some((e) => e.payload?.waived), false);
});

test('without a terminal nothing is waived: aos sign refuses an agent, and aos verify only reports the two groups', async () => {
  const root = delivered([SUBSTANCE, FORM, FORM_2]);
  await assert.rejects(sign(root, { isTTY: false, ask: async () => 'WAIVE' }), (x) => x.code === 'E_OWNER_TTY');
  const agent = aos(root, ['sign'], 'WAIVE\na reason that is long enough\nCLOSE\n');
  assert.equal(agent.status, 1);
  assert.match(agent.stderr, /E_OWNER_TTY/);
  // aos verify runs every check as before and reports the failed ones in two groups; it has no waiver.
  const v = aos(root, ['verify', 'ORD-0001']);
  assert.equal(v.status, 1);
  assert.match(v.stdout, /^FAIL the work \(exit 1, expected 0\)$/m);
  assert.match(v.stdout, /^FAIL \[form\] the label of the report \(exit 1, expected 0\)$/m);
  assert.match(v.stderr, /E_VERIFY_FAILED 3 of 3 checks failed \(substance: 1, form: 2\)/);
  const evidence = readFileSync(join(root, '.analucia', 'evidence', 'ORD-0001', 'verify-01.txt'), 'utf8');
  assert.match(evidence, /^failed checks of substance \(1\): the work$/m);
  assert.match(evidence, /^failed checks of form \(2\): the label of the report, the name of the branch$/m);
  assert.equal(stateOf(root), 'delivered');
  // One failed check of substance: the message of before plus its groups; the result is the same refusal.
  const attached = readLog(root).events.filter((e) => e.type === 'evidence.attached' && e.payload.level === 'verified').at(-1);
  assert.deepEqual(attached.payload.checks.map((c) => c.class ?? 'substance'), ['substance', 'form', 'form']);
});

test('aos validate refuses the class form on a check that is substance by nature, and any other class', () => {
  const file = (check) => JSON.stringify({ order: 'ORD-0001', checks: [check] }, null, 2);
  const codes = (check) => validateVerifyText(file(check), 'ORD-0001.json').map((e) => e.code);
  assert.deepEqual(codes(FORM), []);
  assert.deepEqual(codes({ ...PASSING, class: 'substance' }), []);
  assert.deepEqual(codes({ ...PASSING, class: 'style' }), ['E_FIELD_TYPE']);
  const forbidden = [
    'node --test plugins/analucia/tests > /dev/null 2>&1',
    'node plugins/analucia/bin/aos.mjs verify-log',
    'node plugins/analucia/bin/aos.mjs validate > /dev/null',
    'node "C:/x/bin/aos.mjs" check-roles',
    'node scripts/release-guard.mjs ../lab/release-denylist.txt',
    'npm test',
  ];
  for (const run of forbidden) assert.deepEqual(codes({ name: 'x', run, expect_exit: 0, class: 'form' }), ['E_FORM_CLASS'], run);
  // The same commands without the class are checks of substance, as every check was.
  for (const run of forbidden) assert.deepEqual(codes({ name: 'x', run, expect_exit: 0 }), [], run);
  // A check of form that only names a file the suite also has is not refused by a word in a path.
  assert.deepEqual(codes({ name: 'x', run: "grep -q '^Work: ' report.md", expect_exit: 0, class: 'form' }), []);
  // A preflight check has no class.
  const pre = JSON.stringify({ order: 'ORD-0001', preflight: [{ ...PASSING, class: 'form' }], checks: [PASSING] });
  assert.deepEqual(validateVerifyText(pre, 'ORD-0001.json').map((e) => e.code), ['E_UNKNOWN_KEY']);
  // Through the command: the error with its next line.
  const root = mkdtempSync(join(tmpdir(), 'aos-waive-v-'));
  writeFileSync(join(root, 'ORD-0001.json'), file({ name: 'x', run: forbidden[0], expect_exit: 0, class: 'form' }));
  const r = spawnSync(process.execPath, [AOS, 'validate', join(root, 'ORD-0001.json')], { encoding: 'utf8', env });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /E_FORM_CLASS/);
  assert.match(r.stdout, /next \(director\)/);
});
