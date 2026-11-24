// ORD-0046 part 5 (option B, AMD-0027): the dispatcher. It places the drafts the owner decided, verifies, and works out
// the next run (name, model, effort, brief); it opens nothing and calls no command line. The tests drive the real aos
// commands as the executor would. The seven of the brief, the routing rule, and the end-to-end measure (2 + R clicks).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MODELS, acquire, briefFor, decisionMatches, dispatch, lockPath, planNext, proposalFor, release, routeFor } from '../lib/dispatch.mjs';
import { placeDrafts } from '../lib/drafts.mjs';
import { close } from '../lib/lifecycle.mjs';
import { appendEvent, logPath, readLog } from '../lib/log.mjs';
import { replay } from '../lib/state.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const DISPATCH_SRC = fileURLToPath(new URL('../lib/dispatch.mjs', import.meta.url));
const baseEnv = () => { const e = { ...process.env, GIT_TERMINAL_PROMPT: '0' }; delete e.CLAUDE_PROJECT_DIR; delete e.CLAUDE_CODE_SESSION_ID; return e; };
// As the executor session `session` would run it.
const aos = (root, args, session) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input: '', env: { ...baseEnv(), ...(session ? { CLAUDE_CODE_SESSION_ID: session } : {}) } });

const order = (id, extra = [], risk = 'low') => ['---', `id: ${id}`, `title: Title of ${id}`, 'kind: fix', 'created: 2026-11-14', 'budget_max_minutes: 30', 'budget_max_attempts: 3', `risk: ${risk}`, 'cost_effect: none', ...extra, '---', '', '## Acceptance criteria', '', '- [ ] x', ''].join('\n');
const VERIFY = (id) => `${JSON.stringify({ order: id, checks: [{ name: 'the check', run: 'exit 0', expect_exit: 0 }] }, null, 2)}\n`;

function project() {
  const root = mkdtempSync(join(tmpdir(), 'aos-dispatch-'));
  const a = join(root, '.analucia');
  for (const d of ['drafts', 'evidence', 'orders', 'verify']) mkdirSync(join(a, d), { recursive: true });
  writeFileSync(join(a, 'project.json'), `${JSON.stringify({ wip_limit: 1, locale: 'es', project_code: 'DEMO' })}\n`);
  writeFileSync(logPath(root), '');
  return root;
}
const draft = (root, id, { extra = [], risk = 'low' } = {}) => {
  writeFileSync(join(root, '.analucia', 'drafts', `${id}.md`), order(id, extra, risk));
  writeFileSync(join(root, '.analucia', 'drafts', `${id}.request.md`), '- a point of the request => the draft'), writeFileSync(join(root, '.analucia', 'drafts', `${id}.json`), VERIFY(id));
};
const DECISION = 'Aprobado por el dueño: hacer la orden de prueba';
const decide = (root, id, { actor = 'owner', text = DECISION } = {}) => appendEvent(root, { type: 'decision.recorded', actor, subject: id, payload: { text, source: null, orders: [id] } });
const ready = (root, id = 'DEMO-0001', opts) => { draft(root, id, { extra: [`decision: ${DECISION}`], ...opts }); decide(root, id); };
const events = (root) => readLog(root).events;
const state = (root, id) => replay(events(root)).orders[id]?.state;
const runsStarted = (root, id = 'DEMO-0001') => events(root).filter((e) => e.type === 'run.started' && e.subject === id).length;
// The executor's side of a run, with the real commands: start (or take), write the report, finish.
const work = (root, id, session, outcome = 'done', { first = ['run', 'start', id] } = {}) => {
  assert.equal(aos(root, first, session).status, 0);
  mkdirSync(join(root, '.analucia', 'evidence', id), { recursive: true });
  writeFileSync(join(root, '.analucia', 'evidence', id, 'report.md'), `# report\n\n## Evidencia\n\n1. total 1 of 1.\n\nWork: complete\nOUTCOME: ${outcome}\n`);
  const r = aos(root, ['run', 'finish', id, '--outcome', outcome, '--evidence', `.analucia/evidence/${id}/report.md`], session);
  assert.equal(r.status, 0, r.stderr);
};

test('routing rule: executor Sonnet at medium; Opus at high only for a migration; readers Haiku; never the top model', () => {
  assert.deepEqual(routeFor({ role: 'executor', kind: 'fix' }), { model: MODELS.sonnet, effort: 'medium' });
  assert.deepEqual(routeFor({ role: 'executor', kind: 'build' }), { model: 'claude-sonnet-5-5', effort: 'medium' });
  assert.deepEqual(routeFor({ role: 'executor', kind: 'migration' }), { model: MODELS.opus, effort: 'high' });
  assert.deepEqual(routeFor({ role: 'reader' }), { model: MODELS.haiku, effort: 'low' });
  assert.deepEqual(routeFor({}), { model: MODELS.sonnet, effort: 'medium' });
  for (const kind of ['fix', 'build', 'migration', 'docs', null]) for (const role of ['executor', 'reader']) assert.doesNotMatch(routeFor({ role, kind }).model, /fable|max/i);
  assert.throws(() => routeFor({ role: 'director' }), /not for "director"/);
  assert.throws(() => routeFor({ role: 'owner' }));
});

test('unauthorized work is rejected: a draft with no matching owner decision is not placed; an order that is not admitted cannot be run', () => {
  const root = project();
  draft(root, 'DEMO-0001', { extra: [`decision: ${DECISION}`] }); // no decision.recorded at all
  assert.equal(planNext(root).action, 'owner', 'a draft nobody decided is the owner\'s step');
  assert.equal(dispatch(root).stopped, 'owner');
  assert.equal(state(root, 'DEMO-0001'), undefined, 'not placed');
  // A decision whose text differs, or one recorded by an executor or the system, does not count.
  decide(root, 'DEMO-0001', { text: 'Otra cosa' });
  assert.equal(decisionMatches(events(root), 'DEMO-0001', DECISION), false);
  for (const actor of ['executor', 'system']) assert.equal(decisionMatches([{ type: 'decision.recorded', actor, subject: 'DEMO-0001', payload: { text: DECISION, orders: ['DEMO-0001'] } }], 'DEMO-0001', DECISION), false, actor);
  assert.equal(dispatch(root).stopped, 'owner');
  // A high-risk draft is the owner's even with a matching decision.
  const hi = project();
  ready(hi, 'DEMO-0001', { risk: 'high' });
  assert.notEqual(planNext(hi).action, 'place');
  assert.equal(state(hi, 'DEMO-0001'), undefined);
  // A session asked to work on an order that is not admitted is refused by the tool itself.
  const refused = aos(root, ['run', 'start', 'DEMO-0001']);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /E_[A-Z_]+/);
  assert.equal(runsStarted(root), 0);
});

test('a draft with the owner decision is placed and admitted by the dispatcher, recorded as the dispatcher\'s', () => {
  const root = project();
  ready(root);
  const dry = dispatch(root, { dryRun: true });
  assert.equal(dry.stopped, 'dry_run');
  assert.deepEqual(dry.did, [{ would_place: ['DEMO-0001'] }]);
  assert.equal(state(root, 'DEMO-0001'), undefined, 'a dry run changes nothing');
  const r = dispatch(root);
  assert.ok(r.did.some((d) => d.placed?.includes('DEMO-0001')));
  assert.equal(state(root, 'DEMO-0001'), 'queued');
  const placed = events(root).find((e) => e.type === 'operation.logged' && e.payload?.operation === 'drafts_placed');
  assert.equal(placed.payload.by, 'dispatcher');
  assert.notEqual(placed.actor, 'owner');
  assert.equal(events(root).filter((e) => e.type === 'decision.recorded').length, 1, 'no second decision recorded as the owner');
  assert.equal(r.stopped, 'next_run');
  assert.equal(r.next.name, 'DEMO-0001 run 1');
  assert.equal(runsStarted(root), 0, 'it never starts the run: the owner\'s click does');
});

test('a dependency that is not done blocks the start', () => {
  const root = project();
  ready(root, 'DEMO-0001');
  ready(root, 'DEMO-0002', { extra: ['depends_on: [DEMO-0001]'] });
  placeDrafts(root, { by: 'dispatcher' });
  assert.equal(state(root, 'DEMO-0001'), 'queued');
  assert.equal(aos(root, ['run', 'start', 'DEMO-0001']).status, 0);
  assert.equal(aos(root, ['pause', 'DEMO-0001', '--reason', 'owner pause']).status, 0);
  const plan = planNext(root);
  assert.notEqual(plan.action, 'session');
  assert.equal(plan.why, 'dependency');
  assert.deepEqual(plan.deps, ['DEMO-0001']);
  assert.equal(dispatch(root).stopped, 'wait');
});

test('exclusive assignment: a live lock stops the dispatcher; the lock of a dead process does not', async () => {
  const root = project();
  ready(root);
  const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  try {
    mkdirSync(join(root, '.analucia', 'views'), { recursive: true });
    writeFileSync(lockPath(root), `${JSON.stringify({ pid: live.pid })}\n`);
    const r = dispatch(root);
    assert.equal(r.stopped, 'busy');
    assert.equal(r.pid, live.pid);
    assert.equal(state(root, 'DEMO-0001'), undefined, 'nothing placed either');
  } finally {
    live.kill();
  }
  await new Promise((res) => live.on('close', res));
  writeFileSync(lockPath(root), `${JSON.stringify({ pid: live.pid })}\n`); // the same pid, now dead
  assert.equal(dispatch(root).stopped, 'next_run');
  assert.equal(existsSync(lockPath(root)), false, 'the lock is released at the end');
  assert.equal(acquire(root).ok, true);
  release(root);
  // One order at a time: with a run open the dispatcher proposes no second one.
  assert.equal(aos(root, ['run', 'start', 'DEMO-0001'], 's1').status, 0);
  ready(root, 'DEMO-0002');
  assert.equal(dispatch(root).stopped, 'wait', 'the second order is placed and queued, but no second run is proposed');
  assert.equal(state(root, 'DEMO-0002'), 'queued');
  assert.equal(runsStarted(root, 'DEMO-0002'), 0);
});

test('recovery without duplicate effects: a dispatcher that dies and starts again proposes the same take of the open run, never a second run', () => {
  const root = project();
  ready(root);
  dispatch(root);
  assert.equal(aos(root, ['run', 'start', 'DEMO-0001'], 's1').status, 0);
  assert.equal(runsStarted(root), 1);
  // The session s1 is alive (no session.end): the run is its own, nothing is proposed.
  assert.equal(planNext(root).action, 'wait');
  assert.equal(dispatch(root).stopped, 'wait');
  // The session ended without finishing: the next start proposes taking it, the same way each time.
  appendEvent(root, { type: 'session.end', actor: 'system', subject: 'DEMO-0001', payload: { session: 's1', order: 'DEMO-0001', provider: 'claude-code', reason: 'other' } });
  const a = dispatch(root);
  const b = dispatch(root);
  assert.equal(a.stopped, 'next_run');
  assert.deepEqual(a.next, b.next, 'restarting the dispatcher gives the same proposal');
  assert.equal(a.next.take, true);
  assert.match(a.next.brief, /run take DEMO-0001/);
  assert.equal(runsStarted(root), 1, 'no second run was started');
  assert.equal(aos(root, ['run', 'take', 'DEMO-0001'], 's2').status, 0);
  assert.equal(runsStarted(root), 1);
  assert.ok(events(root).some((e) => e.type === 'operation.logged' && e.payload?.operation === 'run.take' && e.payload.session === 's2'));
});

test('evidence is kept before any retry: a run that failed leaves its report, and the retry is a new run proposed, never a cleanup', () => {
  const root = project();
  ready(root);
  dispatch(root);
  work(root, 'DEMO-0001', 's1', 'failed');
  const report = join(root, '.analucia', 'evidence', 'DEMO-0001', 'report.md');
  assert.equal(state(root, 'DEMO-0001'), 'queued');
  const before = readFileSync(report, 'utf8');
  const r = dispatch(root);
  assert.equal(r.stopped, 'next_run');
  assert.equal(r.next.name, 'DEMO-0001 run 2');
  assert.equal(readFileSync(report, 'utf8'), before, 'the dispatcher deleted and rewrote nothing');
  assert.equal(runsStarted(root), 1, 'proposed, not started');
});

test('nothing is accepted because the agent finished: delivered only by run finish, verified only by aos verify', () => {
  const root = project();
  ready(root);
  dispatch(root);
  assert.equal(state(root, 'DEMO-0001'), 'queued');
  work(root, 'DEMO-0001', 's1');
  assert.equal(state(root, 'DEMO-0001'), 'delivered', 'the finished session only delivered');
  assert.equal(events(root).some((e) => e.type === 'order.state_changed' && e.payload?.to === 'verified'), false);
  const out = dispatch(root);
  assert.ok(out.did.some((d) => d.verified === 'DEMO-0001'));
  assert.equal(state(root, 'DEMO-0001'), 'verified');
  const v = events(root).find((e) => e.type === 'order.state_changed' && e.payload?.to === 'verified');
  assert.equal(v.actor, 'system');
  assert.equal(out.stopped, 'owner', 'then it waits for the owner: it never closes');
});

test('an instruction that contradicts the rules is rejected: no session for the director, no closing, no skipped permission, no command line', () => {
  const root = project();
  ready(root);
  const r = dispatch(root);
  assert.throws(() => routeFor({ role: 'director' }));
  assert.match(r.next.brief, /Never run aos verify, aos close or aos sign/);
  assert.match(r.next.brief, /never skip a permission/);
  assert.match(r.next.brief, /the owner clicks it\. Never start a run yourself/);
  // aos close, run by an agent, is refused: closing is the owner's, at a terminal.
  const closing = aos(root, ['close', 'DEMO-0001'], 's1');
  assert.notEqual(closing.status, 0);
  assert.match(closing.stderr, /E_(OWNER_TTY|TRANSITION)/);
  assert.notEqual(state(root, 'DEMO-0001'), 'closed');
  // The dispatcher opens nothing and calls no command line at all (AMD-0027): its source has no such call.
  const src = readFileSync(DISPATCH_SRC, 'utf8');
  assert.doesNotMatch(src, /claude\.exe|auth (status|login)|'-p'|--no-session-persistence|--model|ANTHROPIC/);
  assert.doesNotMatch(src, /\bspawn\(/);
  assert.deepEqual([...src.matchAll(/spawnSync\('([a-z]+)'/g)].map((m) => m[1]).filter((v, i, a) => a.indexOf(v) === i), ['git']);
});

test('the proposal: name, model, effort and a brief generated from the order, printed by aos dispatch --brief', () => {
  const root = project();
  ready(root);
  dispatch(root);
  const plan = planNext(root);
  const p = proposalFor(root, plan);
  assert.equal(p.name, 'DEMO-0001 run 1');
  assert.equal(p.model, MODELS.sonnet);
  assert.equal(p.effort, 'medium');
  assert.equal(p.brief, briefFor(root, plan.step));
  assert.match(p.brief, /Work only on DEMO-0001,/);
  assert.match(p.brief, /Your first command: .* run start DEMO-0001/);
  const cli = aos(root, ['dispatch', '--brief']);
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /^name: DEMO-0001 run 1\nmodel: claude-sonnet-5-5\neffort: medium\n\n/);
  // A migration goes to Opus at high effort.
  const mig = project();
  writeFileSync(join(mig, '.analucia', 'drafts', 'DEMO-0001.md'), order('DEMO-0001', [`decision: ${DECISION}`]).replace('kind: fix', 'kind: migration'));
  writeFileSync(join(mig, '.analucia', 'drafts', 'DEMO-0001.request.md'), '- a point of the request => the draft'), writeFileSync(join(mig, '.analucia', 'drafts', 'DEMO-0001.json'), VERIFY('DEMO-0001'));
  decide(mig, 'DEMO-0001');
  const m = dispatch(mig).next;
  assert.equal(m.model, MODELS.opus);
  assert.equal(m.effort, 'high');
});

test('the lines for the owner are in tú; FIRMAR\'s line and the dispatch output say what comes next and end with one closing line', () => {
  const root = project();
  ready(root);
  const out = aos(root, ['dispatch']);
  assert.equal(out.status, 0, out.stderr);
  const lines = out.stdout.trimEnd().split('\n');
  assert.match(lines[0], /^Colocadas: DEMO-0001\.$/);
  assert.match(lines[1], /^Sigue: DEMO-0001 run 1 con claude-sonnet-5-5 y esfuerzo medium\./);
  assert.match(lines.at(-1), /^OK: /);
  assert.doesNotMatch(out.stdout, /\busted\b|\bsu\b|\bsus\b|\bpulse\b/i);
});

test('a halt, a broken log and an owner step stop the dispatcher at once', () => {
  const root = project();
  ready(root);
  writeFileSync(join(root, '.analucia', 'HALT'), JSON.stringify({ reason: 'stop' }));
  assert.equal(dispatch(root).stopped, 'halt');
  const root2 = project();
  ready(root2);
  writeFileSync(logPath(root2), `${readFileSync(logPath(root2), 'utf8')}not json\n`);
  assert.equal(dispatch(root2).stopped, 'broken_log');
  assert.equal(state(root, 'DEMO-0001'), undefined);
});

test('end to end: from the owner\'s recorded decision to the signed result, the owner acts exactly 2 times, plus one click per run', async () => {
  const root = project();
  draft(root, 'DEMO-0001', { extra: [`decision: ${DECISION}`] });
  decide(root, 'DEMO-0001'); // owner step 1: he asks
  const first = dispatch(root);
  assert.equal(first.stopped, 'next_run');
  assert.deepEqual(first.did.map((d) => Object.keys(d)[0]), ['placed']);
  let clicks = 1; // the owner clicks the card of run 1
  work(root, 'DEMO-0001', 's1'); // the executor session, started by that click
  const second = dispatch(root);
  assert.deepEqual(second.did.map((d) => Object.keys(d)[0]), ['verified']);
  assert.equal(second.stopped, 'owner', 'it stops by itself when only the owner is left');
  assert.equal(state(root, 'DEMO-0001'), 'verified');
  await close(root, ['DEMO-0001'], { isTTY: true, ask: async () => 'CLOSE' }); // owner step 2: he signs
  assert.equal(state(root, 'DEMO-0001'), 'closed');
  const log = events(root);
  const from = log.findIndex((e) => e.type === 'decision.recorded');
  const touches = new Set(log.slice(from).filter((e) => e.actor === 'owner').map((e) => e.ts));
  assert.equal(touches.size, 2, 'the owner\'s steps in the log: the decision and the signature');
  assert.equal(clicks, runsStarted(root), 'one click per run');
  clicks = clicks + 0;
  assert.equal(touches.size + clicks, 2 + 1);
});
