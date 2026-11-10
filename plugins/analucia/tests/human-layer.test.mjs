// AMD-0007 (ORD-0023): review of documents in aos sign, sessions inside an order, QRSPI as a template, the
// open-orders hint of aos admit.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildViews } from '../lib/derive.mjs';
import { hashLF } from '../lib/lock.mjs';
import { appendEvent, logPath, readLog } from '../lib/log.mjs';
import { decideReview, requestReview, reviewState } from '../lib/review.mjs';
import { sessionsView } from '../lib/sessions.mjs';
import { sign } from '../lib/sign.mjs';
import { replay } from '../lib/state.mjs';
import { sha256Hex, validateOrderText } from '../lib/validate.mjs';
import { workflowCheck } from '../lib/workflow.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
delete env.CLAUDE_PROJECT_DIR;
const aos = (root, args, input = '') => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input, env });
const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' });

const orderText = (id, keys = []) => ['---', `id: ${id}`, `title: Title of ${id}`, 'kind: build', 'created: 2026-10-26',
  'budget_max_minutes: 60', 'budget_max_attempts: 2', 'risk: medium', 'cost_effect: none', ...keys, '---', '', `# ${id}`, '', '## Acceptance criteria', '', '- [ ] It works.', ''].join('\n');

// Two orders, admitted with "aos admit" (ORD-0002 declares workflow: qrspi), in a git repository.
function project({ locale = 'en' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aos-hl-'));
  const a = join(root, '.analucia');
  for (const d of ['orders', 'verify', 'evidence']) mkdirSync(join(a, d), { recursive: true });
  mkdirSync(join(root, 'core'));
  writeFileSync(join(root, 'core', 'SPEC-0003-X.md'), '---\nid: SPEC-0003\nversion: 0.2.0\n---\n');
  writeFileSync(join(a, 'project.json'), `${JSON.stringify({ wip_limit: 1, locale })}\n`);
  writeFileSync(logPath(root), '');
  const files = {};
  for (const [id, keys] of [['ORD-0001', []], ['ORD-0002', ['workflow: qrspi']]]) {
    writeFileSync(join(a, 'orders', `${id}.md`), orderText(id, keys));
    writeFileSync(join(a, 'verify', `${id}.json`), `${JSON.stringify({ order: id, checks: [{ name: 'ok', run: 'exit 0', expect_exit: 0 }] })}\n`);
    for (const rel of [`.analucia/orders/${id}.md`, `.analucia/verify/${id}.json`]) files[rel] = hashLF(readFileSync(join(root, rel)));
  }
  writeFileSync(join(a, 'director.lock'), `${JSON.stringify({ files }, null, 2)}\n`);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  return root;
}
const admitAll = (root) => ['ORD-0001', 'ORD-0002'].map((id) => aos(root, ['admit', id]));
const doc = (root, rel, text) => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
  return rel;
};
const scripted = (answers, asked = []) => async (q) => { asked.push(q); return answers.shift() ?? ''; };
const types = (root) => readLog(root).events.map((e) => e.type);

// ---------- Part D ----------

test('admit lists the open orders and the addendum reminder first, and still admits (information only)', () => {
  const root = project();
  const [first, second] = admitAll(root);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^Open orders \(0\):\nIf this is a correction or an extension of one of these, write an addendum to it instead of a new order\.\n\nORD-0001: admitted/);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /^Open orders \(1\):\n {2}- ORD-0001 Title of ORD-0001 \(queued\)\nIf this is a correction/);
  assert.match(second.stdout, /ORD-0002: admitted/);
  const es = project({ locale: 'es' });
  assert.match(admitAll(es)[1].stdout, /^Órdenes abiertas \(1\):[\s\S]*escribe un addendum a esa orden en lugar de una orden nueva\./);
});

// ---------- Part A ----------

test('review request records path, LF-normalised sha256 and order; it refuses a path outside, an unknown order and a missing file', () => {
  const root = project();
  admitAll(root);
  doc(root, 'docs/plan.md', '# Plan\r\n\r\nShip it.\r\n');
  const r = aos(root, ['review', 'request', 'docs/plan.md', '--order', 'ORD-0001']);
  assert.equal(r.status, 0, r.stderr);
  const e = readLog(root).events.at(-1);
  assert.equal(e.type, 'review.requested');
  assert.equal(e.actor, 'executor');
  assert.equal(e.subject, 'ORD-0001');
  assert.deepEqual(e.payload, { path: 'docs/plan.md', sha256: hashLF(Buffer.from('# Plan\n\nShip it.\n')), order: 'ORD-0001' });
  const before = types(root).length;
  assert.match(aos(root, ['review', 'request', join(tmpdir(), 'elsewhere.md'), '--order', 'ORD-0001']).stderr, /E_REVIEW_PATH/);
  assert.match(aos(root, ['review', 'request', 'docs/plan.md', '--order', 'ORD-0099']).stderr, /E_NO_ORDER/);
  assert.match(aos(root, ['review', 'request', 'docs/none.md', '--order', 'ORD-0001']).stderr, /E_FILE_MISSING/);
  assert.equal(types(root).length, before, 'nothing written on a refusal');
  assert.equal(aos(root, ['validate']).status, 0);
});

test('aos sign: documents first (in the owner language); approve, open then comment; a decision is not a close', async () => {
  const root = project({ locale: 'es' });
  admitAll(root);
  requestReview(root, doc(root, 'docs/design.md', '# Diseño de la tienda\n\nUna página con el catálogo y un carrito.\n'), { order: 'ORD-0001' });
  requestReview(root, doc(root, 'docs/plan.md', '# Plan\n\nTres pasos.\n'), { order: 'ORD-0001' });
  const opened = [];
  const asked = [];
  const lines = [];
  const r = await sign(root, {
    isTTY: true, push: false, out: (s) => lines.push(s), open: (p) => { opened.push(p); return true; },
    ask: scripted(['approve', 'open', 'maybe', 'comment', 'Falta el paso de pruebas'], asked),
  });
  const text = lines.join('\n');
  assert.match(text, /2 documento\(s\) esperan tu revisión\./);
  assert.match(text, /Documento: Diseño de la tienda \(orden ORD-0001\)\n {2}archivo: docs\/design\.md\n {2}en breve: Una página con el catálogo y un carrito\./);
  assert.match(asked[0], /Escribe approve, comment o reject/);
  assert.equal(opened.length, 1);
  // ORD-0024 part D: open shows a readable HTML page from the temp folder, never written into the repository.
  assert.ok(opened[0].endsWith('plan.html') && opened[0].startsWith(tmpdir()) && !opened[0].startsWith(root), opened[0]);
  assert.match(readFileSync(opened[0], 'utf8'), /<h1>Plan<\/h1>\n<p>Tres pasos\.<\/p>/);
  assert.match(text, /Escribe approve, comment, reject u open\./, 'an invalid word is asked again');
  assert.deepEqual(r.reviewed.map((x) => [x.path, x.decision]), [['docs/design.md', 'approve'], ['docs/plan.md', 'comment']]);
  assert.equal(r.committed, true, 'the decisions are committed even when no order is closed');
  assert.match(git(root, 'log', '-1', '--format=%B').stdout, /^Sign-off: 2 review decision\(s\) \(owner, aos sign\)\n\nAnalucia-Order: ORD-0001/);
  const decisions = readLog(root).events.filter((e) => e.type === 'review.decision');
  assert.deepEqual(decisions.map((e) => [e.actor, e.payload.decision, e.payload.note]), [['owner', 'approve', ''], ['owner', 'comment', 'Falta el paso de pruebas']]);
  assert.equal(decisions[0].payload.sha256, hashLF(readFileSync(join(root, 'docs', 'design.md'))));
  assert.equal(replay(readLog(root).events).orders['ORD-0001'].state, 'queued', 'a review decision never closes an order');
  assert.equal(aos(root, ['validate']).status, 0);
  assert.equal(aos(root, ['check-roles']).status, 1, 'no AGENTS.md here; the review decisions themselves are fine');
  assert.doesNotMatch(aos(root, ['check-roles']).stderr, /review\.decision/);
});

test('notes reach the agent under "Corrections to apply"; a changed or re-requested document returns to the list', () => {
  const root = project();
  admitAll(root);
  const a = requestReview(root, doc(root, 'docs/a.md', '# A\n\nFirst.\n'), { order: 'ORD-0001' }).path;
  const b = requestReview(root, doc(root, 'docs/b.md', '# B\n\nSecond.\n'), { order: 'ORD-0001' }).path;
  decideReview(root, a, { decision: 'approve' });
  decideReview(root, b, { decision: 'reject', note: 'Wrong scope' });
  assert.throws(() => decideReview(root, a, { decision: 'approve' }), (x) => x.code === 'E_REVIEW_DECISION', 'already decided for this content');
  let resume = buildViews(root).resume;
  assert.match(resume, /## Corrections to apply \(1\)\n\n- docs\/b\.md \(ORD-0001\) reject by the owner [^:]+:\d\d:\d\d[^ ]*: Wrong scope\. Revise it, then: aos review request docs\/b\.md --order ORD-0001/);
  assert.doesNotMatch(resume, /Documents waiting/);
  assert.deepEqual(reviewState(root).map((d) => [d.path, d.status]), [[a, 'approve'], [b, 'reject']]);
  // The approved file changes: its approval stops counting.
  writeFileSync(join(root, a), '# A\n\nFirst, changed.\n');
  assert.deepEqual(reviewState(root).map((d) => [d.path, d.status]), [[a, 'waiting'], [b, 'reject']]);
  // The rejected one is revised and requested again: it leaves the corrections and waits for the owner.
  writeFileSync(join(root, b), '# B\n\nSecond, narrower.\n');
  requestReview(root, b, { order: 'ORD-0001' });
  resume = buildViews(root).resume;
  assert.doesNotMatch(resume, /Corrections to apply/);
  assert.match(resume, /## Documents waiting for the owner's review \(2\)\n\n- docs\/a\.md \(ORD-0001\): the owner decides in aos sign\n- docs\/b\.md \(ORD-0001\): the owner decides in aos sign/);
  const state = JSON.parse(buildViews(root).state);
  assert.deepEqual(state.reviews.map((d) => d.status), ['waiting', 'waiting']);
});

test('comment and reject need a note; only the owner decides, and check-roles flags any other actor in the log', async () => {
  const root = project();
  admitAll(root);
  const p = requestReview(root, doc(root, 'docs/c.md', '# C\n'), { order: 'ORD-0001' }).path;
  const lines = [];
  await sign(root, { isTTY: true, push: false, out: (s) => lines.push(s), ask: scripted(['reject', '', 'reject', 'Not needed']) });
  assert.match(lines.join('\n'), /This choice needs a note\./);
  assert.equal(readLog(root).events.filter((e) => e.type === 'review.decision').length, 1);
  // An agent cannot write a decision through aos.
  writeFileSync(join(root, p), '# C, again\n');
  requestReview(root, p, { order: 'ORD-0001' });
  const sha = hashLF(readFileSync(join(root, p)));
  const payload = { path: p, decision: 'approve', note: '', sha256: sha, order: 'ORD-0001' };
  assert.throws(() => appendEvent(root, { type: 'review.decision', actor: 'executor', subject: 'ORD-0001', payload }), (x) => x.code === 'E_TRANSITION');
  const viaCli = aos(root, ['event', 'append', '--type', 'review.decision', '--actor', 'director', '--subject', 'ORD-0001', '--payload', JSON.stringify(payload)]);
  assert.notEqual(viaCli.status, 0);
  assert.match(viaCli.stdout + viaCli.stderr, /E_TRANSITION/);
  // A line written by hand with a valid chain still counts for nothing, and check-roles names it.
  const { raw } = readLog(root);
  const forged = { id: '01JBZZZZZZZZZZZZZZZZZZZZZZ', ts: '2026-10-26T12:00:00-05:00', type: 'review.decision', actor: 'executor', subject: 'ORD-0001', payload, prev: sha256Hex(raw.at(-1)) };
  appendFileSync(logPath(root), `${JSON.stringify(forged)}\n`);
  assert.equal(aos(root, ['verify-log']).status, 0);
  assert.equal(reviewState(root).find((d) => d.path === p).status, 'waiting', 'a non-owner decision never counts');
  const roles = aos(root, ['check-roles']);
  assert.equal(roles.status, 1);
  assert.match(roles.stderr, new RegExp(`line ${raw.length + 1}: review\\.decision by actor executor; only the owner decides a review`));
});

// ---------- Part B ----------

const hook = (root, name, input) => aos(root, ['hook', name], JSON.stringify({ cwd: root, ...input }));

test('sessions: start and end from the hooks, with the order of the open run; the order lifecycle is untouched', () => {
  const root = project();
  admitAll(root);
  assert.equal(hook(root, 'session-start', { session_id: 's-1', source: 'startup', model: 'm' }).status, 0);
  assert.equal(aos(root, ['run', 'start', 'ORD-0001']).status, 0);
  assert.equal(hook(root, 'session-end', { session_id: 's-1', reason: 'prompt_input_exit' }).status, 0);
  const before = JSON.stringify(replay(readLog(root).events).orders);
  assert.equal(hook(root, 'session-start', { session_id: 's-2', source: 'resume' }).status, 0);
  const events = readLog(root).events;
  const starts = events.filter((e) => e.type === 'session.start');
  const end = events.find((e) => e.type === 'session.end');
  assert.deepEqual(starts.map((e) => [e.actor, e.subject, e.payload]), [
    ['system', null, { session: 's-1', order: null, provider: 'claude-code', source: 'startup' }],
    ['system', 'ORD-0001', { session: 's-2', order: 'ORD-0001', provider: 'claude-code', source: 'resume' }],
  ]);
  assert.deepEqual([end.actor, end.subject, end.payload], ['system', 'ORD-0001', { session: 's-1', order: 'ORD-0001', provider: 'claude-code', reason: 'prompt_input_exit' }]);
  assert.equal(JSON.stringify(replay(readLog(root).events).orders), before, 'no order state changed');
  assert.equal(aos(root, ['validate']).status, 0);
  // Without a session id (not called by Claude Code) nothing is recorded, and the end never blocks.
  const n = events.length;
  const quiet = hook(root, 'session-end', {});
  assert.equal(quiet.status, 0);
  assert.equal(readLog(root).events.length, n);
});

test('derive shows an interrupted session with the command to resume it, and a run left open by a session that ended', () => {
  const root = project();
  admitAll(root);
  hook(root, 'session-start', { session_id: 'aaa', source: 'startup' });
  aos(root, ['run', 'start', 'ORD-0001']);
  // aaa never ends (the window was closed). bbb starts later, works on the open run and ends normally.
  hook(root, 'session-start', { session_id: 'bbb', source: 'startup' });
  hook(root, 'session-end', { session_id: 'bbb', reason: 'other' });
  const views = buildViews(root);
  const sessions = JSON.parse(views.state).sessions;
  assert.deepEqual(sessions.map((s) => [s.session, s.order, s.status, s.run_open]), [['aaa', null, 'interrupted', false], ['bbb', 'ORD-0001', 'ended', true]]);
  assert.match(views.resume, /## Sessions \(2\)\n\n- ORD-0001: 1 session\(s\)\n- no order: 1 session\(s\), 1 interrupted/);
  assert.match(views.resume, /- interrupted: session aaa \(no order\) started \S+, never ended\. Resume it: claude --resume aaa/);
  assert.match(views.resume, /- run still open: session bbb ended \S+ \(other\) while the run of ORD-0001 was open\. Resume it: claude --resume bbb, or record the outcome with aos run finish ORD-0001/);
  // A resume of the same session is a continuation, not an interruption.
  hook(root, 'session-start', { session_id: 'aaa', source: 'resume' });
  hook(root, 'session-end', { session_id: 'aaa', reason: 'other' });
  assert.deepEqual(sessionsView(readLog(root).events).map((s) => [s.session, s.status, s.starts]), [['bbb', 'ended', 1], ['aaa', 'ended', 2]]);
});

test('a log with no session or review events derives exactly as before (no new sections, no new state keys)', () => {
  const root = project();
  admitAll(root);
  const views = buildViews(root);
  assert.deepEqual(Object.keys(JSON.parse(views.state)), ['generated_from', 'wip_limit', 'counts', 'orders', 'asks', 'pending_signatures', 'queue']);
  assert.doesNotMatch(views.resume, /Sessions|Corrections|Documents waiting/);
});

// ---------- Part C ----------

test('workflow: qrspi validates, any other value is E_WORKFLOW_ENUM, and no workflow changes nothing', () => {
  assert.deepEqual(validateOrderText(orderText('ORD-0003', ['workflow: qrspi']), 'ORD-0003.md'), []);
  assert.deepEqual(validateOrderText(orderText('ORD-0003'), 'ORD-0003.md'), []);
  assert.deepEqual(validateOrderText(orderText('ORD-0003', ['workflow: waterfall']), 'ORD-0003.md').map((e) => e.code), ['E_WORKFLOW_ENUM']);
});

test('aos workflow check: exit 1 until design.md and plan.md have a current approve, 1 again when one changes', () => {
  const root = project();
  admitAll(root);
  const run = () => aos(root, ['workflow', 'check', 'ORD-0002']);
  let r = run();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL \.analucia\/artifacts\/ORD-0002\/design\.md: missing\nFAIL \.analucia\/artifacts\/ORD-0002\/plan\.md: missing/);
  const design = requestReview(root, doc(root, '.analucia/artifacts/ORD-0002/design.md', '# Design\n\nOne page.\n'), { order: 'ORD-0002' }).path;
  const plan = requestReview(root, doc(root, '.analucia/artifacts/ORD-0002/plan.md', '# Plan\n\nTwo steps.\n'), { order: 'ORD-0002' }).path;
  decideReview(root, design, { decision: 'approve' });
  r = run();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /PASS \.analucia\/artifacts\/ORD-0002\/design\.md: approved by the owner[\s\S]*FAIL \.analucia\/artifacts\/ORD-0002\/plan\.md: waiting/);
  decideReview(root, plan, { decision: 'approve' });
  r = run();
  assert.equal(r.status, 0, r.stdout);
  writeFileSync(join(root, plan), '# Plan\n\nThree steps.\n');
  assert.equal(run().status, 1, 'a changed plan needs a new approval');
  const plain = aos(root, ['workflow', 'check', 'ORD-0001']);
  assert.match(plain.stdout, /does not declare "workflow: qrspi"/);
  assert.equal(aos(root, ['workflow', 'check', 'ORD-0009']).status, 1);
});

test('the QRSPI template names the six stages, the five documents, the gate and the attribution', () => {
  const t = readFileSync(fileURLToPath(new URL('../templates/workflow-qrspi.md', import.meta.url)), 'utf8');
  for (const w of ['Questions', 'Research', 'Design', 'Structure', 'Plan', 'Implement', 'questions.md', 'research.md', 'design.md', 'structure.md', 'plan.md', 'aos workflow check', 'HumanLayer', 'not** a lifecycle']) assert.ok(t.includes(w), w);
});
