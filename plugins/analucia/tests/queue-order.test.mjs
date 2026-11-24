// ORD-0047 part 9 (OBS-211): an explicit queue. `aos queue set` records the order in which queued orders run (the
// existing event operation.logged); `aos next`, the dispatcher, `aos status` and the queue view follow it; an order not in
// it comes after, in the order of admission; a draft named by topic is shown by its topic until it has a number.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { placeDrafts } from '../lib/drafts.mjs';
import { logPath, readLog } from '../lib/log.mjs';
import { nextStep } from '../lib/next.mjs';
import { buildQueue, explicitQueue, queueText, writeQueueView } from '../lib/queue.mjs';
import { replay } from '../lib/state.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = () => { const e = { ...process.env, GIT_TERMINAL_PROMPT: '0' }; delete e.CLAUDE_PROJECT_DIR; delete e.CLAUDE_CODE_SESSION_ID; return e; };
const aos = (root, args) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input: '', env: env() });

function project() {
  const root = mkdtempSync(join(tmpdir(), 'aos-queue-'));
  const a = join(root, '.analucia');
  for (const d of ['drafts', 'evidence', 'orders', 'verify']) mkdirSync(join(a, d), { recursive: true });
  writeFileSync(join(a, 'project.json'), `${JSON.stringify({ wip_limit: 1, locale: 'en', project_code: 'DEMO' })}\n`);
  writeFileSync(logPath(root), '');
  return root;
}
const topicDraft = (root, topic) => {
  const d = join(root, '.analucia', 'drafts');
  writeFileSync(join(d, `draft-${topic}.md`), ['---', 'id: {id}', `title: Title of ${topic}`, 'kind: fix', 'created: 2026-11-22', 'budget_max_minutes: 30', 'budget_max_attempts: 3', 'risk: low', 'cost_effect: none', '---', '', '## Acceptance criteria', '', '- [ ] x', ''].join('\n'));
  writeFileSync(join(d, `draft-${topic}.json`), `${JSON.stringify({ order: '{id}', checks: [{ name: 'c', run: 'exit 0', expect_exit: 0 }] })}\n`);
  writeFileSync(join(d, `draft-${topic}.request.md`), '- a point => the draft\n');
};
// Three orders placed in this order: DEMO-0001 (a), DEMO-0002 (b), DEMO-0003 (c).
function three() {
  const root = project();
  for (const t of ['a', 'b', 'c']) { topicDraft(root, t); placeDrafts(root, { ids: [`draft-${t}`] }); }
  return root;
}
const orders = (root) => replay(readLog(root).events).orders;
const ids = (root) => buildQueue(root, orders(root)).map((q) => q.id);

test('without a queue set, the orders go in the order of admission', () => {
  const root = three();
  assert.deepEqual(ids(root), ['DEMO-0001', 'DEMO-0002', 'DEMO-0003']);
  assert.deepEqual(explicitQueue(readLog(root).events), []);
  assert.match(nextStep(root, { explicit: true }).vars.id, /DEMO-0001/);
});

test('aos queue set records the order with operation.logged and aos next, the queue view and aos status follow it', () => {
  const root = three();
  const r = aos(root, ['queue', 'set', 'DEMO-0003', 'DEMO-0001']);
  assert.equal(r.status, 0, r.stderr);
  const ev = readLog(root).events.at(-1);
  assert.equal(ev.type, 'operation.logged');
  assert.deepEqual([ev.payload.operation, ev.payload.ids, ev.actor], ['queue.set', ['DEMO-0003', 'DEMO-0001'], 'director']);
  // listed first, in its order; the order that is not in it comes after
  assert.deepEqual(ids(root), ['DEMO-0003', 'DEMO-0001', 'DEMO-0002']);
  assert.match(r.stdout, /1\. DEMO-0003/);
  assert.equal(nextStep(root, { explicit: true }).vars.id, 'DEMO-0003', 'aos next follows the queue');
  assert.match(aos(root, ['next']).stdout, /DEMO-0003/);
  const view = writeQueueView(root, buildQueue(root, orders(root)));
  assert.ok(view.indexOf('DEMO-0003') < view.indexOf('DEMO-0001') && view.indexOf('DEMO-0001') < view.indexOf('DEMO-0002'));
  const st = aos(root, ['status']).stdout;
  assert.ok(st.indexOf('DEMO-0003') < st.indexOf('DEMO-0001') && st.indexOf('DEMO-0001') < st.indexOf('DEMO-0002'), st);
  // the last set wins
  aos(root, ['queue', 'set', 'DEMO-0002']);
  assert.deepEqual(ids(root), ['DEMO-0002', 'DEMO-0001', 'DEMO-0003']);
});

test('an order placed after the queue was set goes at the end', () => {
  const root = three();
  aos(root, ['queue', 'set', 'DEMO-0002', 'DEMO-0001']);
  topicDraft(root, 'd');
  placeDrafts(root, { ids: ['draft-d'] });
  assert.deepEqual(ids(root), ['DEMO-0002', 'DEMO-0001', 'DEMO-0003', 'DEMO-0004']);
  // (a dependency of an order still goes before it: see queue-sign.test.mjs, which pins that rule)
});

test('aos queue set refuses an unknown order, a closed one, a repeated one and an empty list; nothing is recorded', () => {
  const root = three();
  const before = readFileSync(logPath(root), 'utf8');
  for (const args of [['queue', 'set', 'DEMO-0099'], ['queue', 'set', 'DEMO-0001', 'DEMO-0001'], ['queue', 'set'], ['queue']]) {
    const r = aos(root, args);
    assert.notEqual(r.status, 0, args.join(' '));
  }
  assert.equal(readFileSync(logPath(root), 'utf8'), before);
});

test('the queue view shows a draft named by topic by its topic until it has a number', () => {
  const root = three();
  topicDraft(root, 'banner-search');
  const view = writeQueueView(root, buildQueue(root, orders(root)));
  assert.match(view, /banner-search — draft by topic, no number yet/);
  assert.match(queueText([], 'en', [], ['x']), /x — draft by topic/);
  assert.match(queueText([], 'es', [], ['x']), /borrador por tema/);
});
