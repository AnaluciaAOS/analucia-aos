// ORD-0046 part 6: the three measures per order in `aos status --metric` (human touches, active minutes, cost by
// model), read from the log only; ESTADO shows the touches.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TOUCH_TARGET, activeMinutesOf, costByModelOf, touchesOf } from '../lib/measures.mjs';
import { appendEvent, logPath } from '../lib/log.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
delete env.CLAUDE_PROJECT_DIR;
const aos = (root, args) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input: '', env });

const at = (min) => new Date(Date.UTC(2026, 10, 20, 15, 0, 0) + min * 60000).toISOString();
const stamp = (rows) => rows.map(([type, actor, subject, min, payload = {}], i) => ({ id: `E${i}`, ts: at(min), type, actor, subject, payload }));

test('human touches: the owner\'s moments from his decision to the signature; the same moment is one touch; the target is 2', () => {
  const events = stamp([
    ['decision.recorded', 'owner', 'ORD-0001', 0, { text: 'x', orders: ['ORD-0001'] }],
    ['operation.logged', 'owner', null, 0, { operation: 'drafts_placed' }], // same moment: one command
    ['run.started', 'executor', 'ORD-0001', 5],
    ['run.finished', 'executor', 'ORD-0001', 20],
    ['order.state_changed', 'owner', 'ORD-0001', 90, { to: 'closed' }],
    ['operation.logged', 'owner', null, 120, { operation: 'later' }], // after the signature: not counted
  ]);
  assert.equal(touchesOf(events, 'ORD-0001'), 2);
  assert.equal(TOUCH_TARGET, 2);
  assert.equal(touchesOf(events, 'ORD-0002'), null, 'no decision, no measure');
  // Still open: counted up to now.
  assert.equal(touchesOf(events.slice(0, 3), 'ORD-0001'), 1);
});

test('active minutes: time inside the runs; a gap longer than 15 minutes is not counted', () => {
  const events = stamp([
    ['run.started', 'executor', 'ORD-0001', 0],
    ['operation.logged', 'executor', null, 10], // 10 counted
    ['operation.logged', 'executor', null, 40], // 30-minute gap: not counted
    ['operation.logged', 'executor', null, 45], // 5 counted
    ['run.finished', 'executor', 'ORD-0001', 60], // 15 minutes: counted (not longer than 15)
    ['operation.logged', 'owner', null, 600], // outside any run: not counted
  ]);
  assert.equal(activeMinutesOf(events, 'ORD-0001'), 30);
  assert.equal(activeMinutesOf(events, 'ORD-0001', { gapMs: 60 * 60000 }), 60, 'the idle limit is a parameter');
  assert.equal(activeMinutesOf(events, 'ORD-0002'), 0);
  // An open run counts to its last event.
  assert.equal(activeMinutesOf(events.slice(0, 2), 'ORD-0001'), 10);
});

test('cost by model: what the command line reported, summed per model; "not known" for runs not opened by the dispatcher', () => {
  const rec = (model, usd) => ['operation.logged', 'system', 'ORD-0001', 1, { operation: 'dispatch.session', model, cost_usd: usd, run: 1, session: 's' }];
  const events = stamp([rec('claude-sonnet-5-5', 0.25), rec('claude-sonnet-5-5', 0.5), rec('claude-opus-5-5', 1.5), ['operation.logged', 'system', 'ORD-0002', 2, { operation: 'dispatch.session', model: 'm', cost_usd: 9 }]]);
  assert.deepEqual(costByModelOf(events, 'ORD-0001'), { 'claude-sonnet-5-5': 0.75, 'claude-opus-5-5': 1.5 });
  assert.equal(costByModelOf(events, 'ORD-0003'), null);
  assert.equal(costByModelOf(stamp([['run.started', 'executor', 'ORD-0001', 0]]), 'ORD-0001'), null);
  assert.equal(costByModelOf(stamp([['operation.logged', 'system', 'ORD-0001', 1, { operation: 'cost', usd: 3 }]]), 'ORD-0001'), null, 'a budget cost record is not a model cost');
});

function project() {
  const root = mkdtempSync(join(tmpdir(), 'aos-measures-'));
  const a = join(root, '.analucia');
  for (const d of ['orders', 'verify', 'evidence']) mkdirSync(join(a, d), { recursive: true });
  writeFileSync(join(a, 'project.json'), `${JSON.stringify({ wip_limit: 1, locale: 'es', project_code: 'DEMO' })}\n`);
  writeFileSync(logPath(root), '');
  return root;
}

test('aos status --metric and aos status <ID> print the three measures; ESTADO shows the touches in tú, within six lines', () => {
  const root = project();
  const id = 'DEMO-0001';
  writeFileSync(join(root, '.analucia', 'orders', `${id}.md`), ['---', `id: ${id}`, 'title: T', 'kind: fix', 'created: 2026-11-14', 'budget_max_minutes: 30', 'budget_max_attempts: 2', 'risk: low', 'cost_effect: none', '---', '', '## Part 1 — A', '', '## Part 2 — B', ''].join('\n'));
  appendEvent(root, { type: 'decision.recorded', actor: 'owner', subject: id, payload: { text: 'ok', orders: [id] } });
  appendEvent(root, { type: 'record.created', actor: 'director', subject: id });
  appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: id, payload: { from: 'draft', to: 'ready' } });
  appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: id, payload: { from: 'ready', to: 'queued' } });
  appendEvent(root, { type: 'run.started', actor: 'executor', subject: id, payload: { run: 1, budget: { max_minutes: 30, max_attempts: 2 } } });
  const metric = aos(root, ['status', '--metric']);
  assert.equal(metric.status, 0, metric.stderr);
  assert.match(metric.stdout, /medidas: intervenciones humanas 1 \(meta 2\) · minutos activos \d+(\.\d)? · costo por modelo: no se conoce/);
  const one = aos(root, ['status', id]);
  assert.match(one.stdout, /medidas: intervenciones humanas 1 \(meta 2\)/);
  const estado = aos(root, ['status', '--owner']);
  const lines = estado.stdout.trimEnd().split('\n');
  assert.ok(lines.length <= 6, `${lines.length} lines`);
  assert.ok(lines.some((l) => /^Hasta ahora has intervenido 1 vez\/veces en esta orden \(meta: 2\); minutos activos: \d+(\.\d)?\.$/.test(l)), estado.stdout);
  assert.doesNotMatch(estado.stdout, /\busted\b|\bsu\b|\bsus\b/i);
});
