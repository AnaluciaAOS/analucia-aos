// ORD-0043 part 6 (OBS-165): the owner's gates at the end. A document the owner must look at is asked with
// `aos review request` and the work goes on; `aos sign` shows all the reviews of one order together, before its
// checks, and one decision of "corrections" (comment or reject) sends that order back for rework (the transition
// delivered -> active that exists) without touching the others. `aos status` starts with one line of who waits for
// whom.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AOS_BIN } from '../lib/cli.mjs';
import { hashLF } from '../lib/lock.mjs';
import { appendEvent, logPath, readLog } from '../lib/log.mjs';
import { sign } from '../lib/sign.mjs';
import { replay } from '../lib/state.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
delete env.CLAUDE_PROJECT_DIR;
delete env.CLAUDE_CODE_SESSION_ID;
const aos = (root, args) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input: '', env });
const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' });
const CMD = `node "${AOS_BIN}"`;
const REPORT = '# r\n\n## Evidencia\n\nx\n\nWork: complete\nOUTCOME: done\n';
const DOC = (title) => `# ${title}\n\nWhat the owner must look at.\n\n## Decisiones\n\nNinguna\n`;

// Queued orders with a passing check each, in a git repository (no remote: nothing is pushed).
function project(ids) {
  const root = mkdtempSync(join(tmpdir(), 'aos-gate-'));
  const a = join(root, '.analucia');
  for (const d of ['orders', 'verify', 'evidence']) mkdirSync(join(a, d), { recursive: true });
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(a, 'project.json'), '{"wip_limit":2,"locale":"en"}\n');
  writeFileSync(logPath(root), '');
  writeFileSync(join(a, 'evidence', 'report.md'), REPORT);
  const files = {};
  for (const id of ids) {
    writeFileSync(join(a, 'orders', `${id}.md`), ['---', `id: ${id}`, `title: Title of ${id}`, 'kind: fix', 'created: 2026-11-16', 'budget_max_minutes: 30', 'budget_max_attempts: 3', '---', '', '## Acceptance criteria', '', '- [ ] x', ''].join('\n'));
    writeFileSync(join(a, 'verify', `${id}.json`), JSON.stringify({ order: id, checks: [{ name: 'the check', run: 'exit 0', expect_exit: 0 }] }));
    for (const rel of [`.analucia/orders/${id}.md`, `.analucia/verify/${id}.json`]) files[rel] = hashLF(readFileSync(join(root, rel)));
    appendEvent(root, { type: 'record.created', actor: 'director', subject: id });
    appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: id, payload: { from: 'draft', to: 'ready' } });
    appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: id, payload: { from: 'ready', to: 'queued' } });
  }
  writeFileSync(join(a, 'director.lock'), JSON.stringify({ files }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  return root;
}
// The executor asks for the reviews and goes on to `done`: the work does not stop for the owner.
function deliver(root, id, docs) {
  assert.equal(aos(root, ['run', 'start', id]).status, 0);
  for (const name of docs) {
    writeFileSync(join(root, 'docs', name), DOC(name));
    const r = aos(root, ['review', 'request', `docs/${name}`, '--order', id]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
  }
  assert.equal(aos(root, ['run', 'finish', id, '--outcome', 'done', '--evidence', '.analucia/evidence/report.md']).status, 0);
}
// The owner at the terminal: the review answers in the order given, a note when asked, CLOSE to sign.
function owner(decisions) {
  const lines = [];
  const left = [...decisions];
  const ask = async (q) => {
    lines.push(`ASK ${q}`);
    if (/Type approve to approve/.test(q)) return left.shift() ?? '';
    if (/comment|reject/i.test(q)) return 'the table of prices is missing';
    return 'CLOSE';
  };
  return { lines, opts: { isTTY: true, ask, out: (s) => lines.push(s), push: false } };
}
const order = (root, id) => replay(readLog(root).events).orders[id];

test('aos sign shows the reviews of one order together, before its checks; corrections send that order back and leave the others', async () => {
  const root = project(['ORD-0001', 'ORD-0002']);
  deliver(root, 'ORD-0001', ['a-plan.md', 'b-prices.md']);
  deliver(root, 'ORD-0002', ['c-screen.md']);
  const o = owner(['approve', 'comment', 'approve']);
  const r = await sign(root, o.opts);
  const text = o.lines;
  const at = (re) => text.findIndex((l) => re.test(l));
  // The two documents of ORD-0001 together, under its own heading, before anything of ORD-0002.
  assert.ok(at(/ORD-0001: 2 document\(s\) to review/) !== -1, text.join('\n'));
  assert.ok(at(/ORD-0001: 2 document/) < at(/a-plan\.md/) && at(/a-plan\.md/) < at(/b-prices\.md/));
  assert.ok(at(/b-prices\.md/) < at(/ORD-0002: 1 document\(s\) to review/));
  // One decision of corrections: ORD-0001 goes back for rework, and its checks are not run.
  assert.ok(at(/ORD-0001 goes back to the executor for corrections \(1 document/) > at(/b-prices\.md/));
  assert.equal(at(/Checking ORD-0001/), -1);
  assert.deepEqual([order(root, 'ORD-0001').state, order(root, 'ORD-0001').reopens], ['active', 1]);
  assert.equal(existsSync(join(root, '.analucia', 'evidence', 'ORD-0001', 'verify-01.txt')), false);
  const back = readLog(root).events.filter((e) => e.subject === 'ORD-0001' && e.type === 'order.state_changed').at(-1);
  assert.deepEqual([back.actor, back.payload.from, back.payload.to], ['owner', 'delivered', 'active']);
  assert.match(back.payload.reason, /corrections/);
  // ORD-0002 is not touched by it: its review comes before its checks, and it is signed.
  assert.ok(at(/c-screen\.md/) < at(/Checking ORD-0002/));
  assert.deepEqual(r.signed, ['ORD-0002']);
  assert.equal(order(root, 'ORD-0002').state, 'closed');
  assert.deepEqual(r.reviewed.map((d) => [d.order, d.decision]), [['ORD-0001', 'approve'], ['ORD-0001', 'comment'], ['ORD-0002', 'approve']]);
});

test('an order sent back for corrections: aos next gives the executor the command, and a new run starts within the budget', async () => {
  const root = project(['ORD-0001']);
  deliver(root, 'ORD-0001', ['a-plan.md']);
  await sign(root, owner(['reject']).opts);
  assert.equal(order(root, 'ORD-0001').state, 'active');
  assert.equal(aos(root, ['next']).stdout.trimEnd(), `Next (executor): ORD-0001 came back from the owner with corrections. Read "Corrections to apply" in .analucia/views/resume.md, then start the next run with: ${CMD} run start ORD-0001`);
  const started = aos(root, ['run', 'start', 'ORD-0001']);
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stdout, /ORD-0001: active \(rework\), run 2 of 3 started/);
  const events = readLog(root).events;
  assert.deepEqual([events.at(-1).type, events.at(-1).payload.run, events.at(-1).payload.rework], ['run.started', 2, true]);
  assert.equal(events.at(-2).type, 'order.state_changed', 'no second transition: the order is already active');
  assert.equal(events.at(-2).payload.to, 'active');
  // A second start while that run is open is refused as before.
  assert.equal(aos(root, ['run', 'start', 'ORD-0001']).status, 1);
  writeFileSync(join(root, 'docs', 'a-plan.md'), DOC('a-plan.md, corrected'));
  assert.equal(aos(root, ['review', 'request', 'docs/a-plan.md', '--order', 'ORD-0001']).status, 0);
  assert.equal(aos(root, ['run', 'finish', 'ORD-0001', '--outcome', 'done', '--evidence', '.analucia/evidence/report.md']).status, 0);
  const again = await sign(root, owner(['approve']).opts);
  assert.deepEqual(again.signed, ['ORD-0001']);
});

test('a document left for later does not hold the order; with no review at all nothing changes', async () => {
  const root = project(['ORD-0001', 'ORD-0002']);
  deliver(root, 'ORD-0001', ['a-plan.md']);
  deliver(root, 'ORD-0002', []);
  const o = owner(['']);
  const r = await sign(root, o.opts);
  assert.deepEqual(r.signed, ['ORD-0001', 'ORD-0002']);
  assert.equal(o.lines.some((l) => /ORD-0002: \d+ document/.test(l)), false);
});

test('aos status starts with one line of who waits for whom, each with its order and the single action', async () => {
  const root = project(['ORD-0001', 'ORD-0002', 'ORD-0003', 'ORD-0004']);
  const first = (args = ['status']) => aos(root, args).stdout.split('\n')[0];
  assert.equal(first(), 'Waiting — owner 0 · director 0 · executor 1: start ORD-0001');
  deliver(root, 'ORD-0001', ['a-plan.md']);
  deliver(root, 'ORD-0002', []);
  assert.equal(aos(root, ['run', 'start', 'ORD-0003']).status, 0);
  assert.equal(first(), 'Waiting — owner 3: sign ORD-0001, sign ORD-0002, review ORD-0001 · director 0 · executor 1: finish ORD-0003');
  assert.equal(aos(root, ['run', 'finish', 'ORD-0003', '--outcome', 'needs_decision', '--evidence', '.analucia/evidence/report.md', '--reason', 'the spec and the order disagree']).status, 1, 'Work: complete cannot end as needs_decision');
  writeFileSync(join(root, '.analucia', 'evidence', 'report.md'), REPORT.replace('Work: complete', 'Work: not complete'));
  assert.equal(aos(root, ['run', 'finish', 'ORD-0003', '--outcome', 'needs_decision', '--evidence', '.analucia/evidence/report.md', '--reason', 'the spec and the order disagree']).status, 0);
  assert.equal(first(), 'Waiting — owner 3: sign ORD-0001, sign ORD-0002, review ORD-0001 · director 1: decide ORD-0003 · executor 1: start ORD-0004');
  // The rest of the output is as before: one line per order that is not closed, then the closing line.
  const lines = aos(root, ['status']).stdout.trimEnd().split('\n');
  assert.equal(lines.length, 7); // the waiting line, the line of the stop word (ORD-0043 part 15), four orders, the closing line
  assert.match(lines[2], /^ORD-0001 — delivered/);
  assert.equal(lines.at(-1), 'OK: 4 order(s) not closed');
  // In the owner's language.
  writeFileSync(join(root, '.analucia', 'project.json'), '{"wip_limit":2,"locale":"es"}\n');
  assert.match(first(), /^En espera — owner 3: firmar ORD-0001, firmar ORD-0002, revisar ORD-0001 · director 1: decidir ORD-0003 · executor 1: iniciar ORD-0004$/);
  // The machine-readable forms are not touched.
  assert.doesNotMatch(aos(root, ['status', 'ORD-0001', '--chain', '--json']).stdout, /Waiting|En espera/);
});

test('the director entrypoint says it: a gate in the middle only for a material technical risk, with where and why', () => {
  const entry = readFileSync(fileURLToPath(new URL('../templates/director-entry.md', import.meta.url)), 'utf8');
  const line = entry.split('\n').find((l) => /in the middle/.test(l));
  assert.ok(line);
  assert.match(line, /material technical risk/);
  assert.match(line, /where and why/);
  assert.match(line, /waits for the signature/);
});
