// SPEC-0003 §4, §5, §7: risk tiers, aos admit with pins, version skew, legacy orders.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { admit, close, currentPluginVersion } from '../lib/lifecycle.mjs';
import { hashLF } from '../lib/lock.mjs';
import { appendEvent, logPath, readLog } from '../lib/log.mjs';
import { replay } from '../lib/state.mjs';
import { validateTree } from '../lib/validate.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env };
delete env.CLAUDE_PROJECT_DIR;
const aos = (root, args, input = '') => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input, env });
const refused = (r, code) => {
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, new RegExp(`: ${code} `));
};
const stateOf = (root, id) => replay(readLog(root).events).orders[id];
const log = (root) => readFileSync(logPath(root));

const orderText = (id, keys) => ['---', `id: ${id}`, 'title: Risk fixture', 'kind: build', 'created: 2026-10-21',
  'budget_max_minutes: 60', 'budget_max_attempts: 2', ...keys, '---', '', `# ${id}`, '', '## Acceptance criteria', '', '- [ ] It works.', ''].join('\n');

// orders: [{ id, risk?, rollback?: 'locked' | 'unlocked' | 'missing', lock?: false, keys? }]
function riskProject(orders, { checks = [{ name: 'ok', run: 'exit 0', expect_exit: 0 }] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aos-risk-'));
  const a = join(root, '.analucia');
  for (const d of ['orders', 'verify', 'evidence', 'rollback']) mkdirSync(join(a, d), { recursive: true });
  mkdirSync(join(root, 'core'));
  writeFileSync(join(root, 'core', 'NOMENCLATURE.md'), '---\nid: SPEC-0001\nversion_approved: 0.0.1\nversion: 0.1.0\n---\n');
  writeFileSync(join(root, 'core', 'SPEC-0002-X.md'), '---\nid: SPEC-0002\nversion: 0.1.0\n---\n');
  writeFileSync(join(root, 'core', 'SPEC-0003-X.md'), '---\nid: SPEC-0003\nversion: 0.2.0\n---\n');
  writeFileSync(join(a, 'project.json'), '{"wip_limit":3}\n');
  writeFileSync(logPath(root), '');
  writeFileSync(join(a, 'evidence', 'report.md'), 'evidence\n');
  const files = {};
  const lock = (rel) => { files[rel] = hashLF(readFileSync(join(root, rel))); };
  for (const o of orders) {
    const keys = o.keys ?? [
      ...(o.risk ? [`risk: ${o.risk}`] : []), 'cost_effect: [build]',
      ...(o.rollback ? [`rollback: .analucia/rollback/${o.id}.md`] : []),
    ];
    writeFileSync(join(a, 'orders', `${o.id}.md`), orderText(o.id, keys));
    writeFileSync(join(a, 'verify', `${o.id}.json`), `${JSON.stringify({ order: o.id, checks })}\n`);
    if (o.lock !== false) lock(`.analucia/orders/${o.id}.md`);
    lock(`.analucia/verify/${o.id}.json`);
    if (o.rollback === 'locked' || o.rollback === 'unlocked') {
      writeFileSync(join(a, 'rollback', `${o.id}.md`), '# Rollback\n\n1. git revert the commit.\n2. Check: aos verify.\n');
      if (o.rollback === 'locked') lock(`.analucia/rollback/${o.id}.md`);
    }
  }
  writeFileSync(join(a, 'director.lock'), `${JSON.stringify({ written_by: 'director', files }, null, 2)}\n`);
  return root;
}
const deliver = (root, id) => {
  const s = aos(root, ['run', 'start', id]);
  assert.equal(s.status, 0, s.stdout + s.stderr);
  const f = aos(root, ['run', 'finish', id, '--outcome', 'done', '--evidence', '.analucia/evidence/report.md']);
  assert.equal(f.status, 0, f.stderr);
};

test('admit records the pins, actor director, and queues the order', () => {
  const root = riskProject([{ id: 'ORD-0001', risk: 'low' }]);
  const r = aos(root, ['admit', 'ORD-0001']);
  assert.equal(r.status, 0, r.stderr);
  const events = readLog(root).events;
  assert.deepEqual(events.map((e) => [e.type, e.actor, e.payload.to ?? null]), [
    ['record.created', 'director', null], ['order.state_changed', 'director', 'ready'], ['order.state_changed', 'director', 'queued'],
  ]);
  assert.deepEqual(events[0].payload.pins, { plugin: currentPluginVersion(), specs: { 'SPEC-0001': '0.1.0', 'SPEC-0002': '0.1.0', 'SPEC-0003': '0.2.0' } });
  assert.equal(stateOf(root, 'ORD-0001').state, 'queued');
  assert.deepEqual(validateTree(root), []);
});

test('admit refuses: not in the lock (E_NOT_LOCKED), no file, already admitted, pinned order without risk', () => {
  const root = riskProject([{ id: 'ORD-0001', risk: 'low', lock: false }, { id: 'ORD-0002', keys: ['cost_effect: none'] }, { id: 'ORD-0003', risk: 'medium' }]);
  refused(aos(root, ['admit', 'ORD-0001']), 'E_NOT_LOCKED');
  refused(aos(root, ['admit', 'ORD-0009']), 'E_NO_ORDER');
  refused(aos(root, ['admit', 'ORD-0002']), 'E_MISSING_FIELD');
  assert.equal(log(root).length, 0, 'nothing written by a refused admit');
  assert.equal(aos(root, ['admit', 'ORD-0003']).status, 0);
  refused(aos(root, ['admit', 'ORD-0003']), 'E_RECORD_EXISTS');
});

test('validate requires risk and cost_effect only for orders pinned with SPEC-0003 (old orders still validate)', () => {
  const root = riskProject([{ id: 'ORD-0001', keys: [] }, { id: 'ORD-0002', keys: [] }]);
  appendEvent(root, { type: 'record.created', actor: 'system', subject: 'ORD-0001', payload: { bootstrap: true } });
  assert.deepEqual(validateTree(root), [], 'an unpinned order without risk is accepted');
  appendEvent(root, { type: 'record.created', actor: 'director', subject: 'ORD-0002', payload: { pins: { plugin: '0.1.0', specs: { 'SPEC-0003': '0.1.0' } } } });
  const errs = validateTree(root);
  assert.deepEqual(errs.map((e) => [e.file, e.code]), [['.analucia/orders/ORD-0002.md', 'E_MISSING_FIELD'], ['.analucia/orders/ORD-0002.md', 'E_MISSING_FIELD']]);
  assert.match(errs[0].message, /"risk" is required/);
});

test('legacy (unpinned) orders follow SPEC-0002: no rollback gate, and --as director is refused', () => {
  const root = riskProject([{ id: 'ORD-0001', keys: [] }]);
  appendEvent(root, { type: 'record.created', actor: 'system', subject: 'ORD-0001', payload: { bootstrap: true } }); // no pins
  appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: 'ORD-0001', payload: { from: 'draft', to: 'ready' } });
  appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: 'ORD-0001', payload: { from: 'ready', to: 'queued' } });
  deliver(root, 'ORD-0001');
  const v = aos(root, ['verify', 'ORD-0001']);
  assert.equal(v.status, 0, v.stderr);
  assert.equal(readLog(root).events.find((e) => e.payload.level === 'verified').payload.samples, 1);
  refused(aos(root, ['close', 'ORD-0001', '--as', 'director']), 'E_RISK_CLOSE');
});

test('low: the director closes without a TTY; any other role is refused; a raw director close event is refused', async () => {
  const root = riskProject([{ id: 'ORD-0001', risk: 'low' }]);
  assert.equal(aos(root, ['admit', 'ORD-0001']).status, 0);
  deliver(root, 'ORD-0001');
  assert.equal(aos(root, ['verify', 'ORD-0001']).status, 0);
  const raw = aos(root, ['event', 'append', '--type', 'order.state_changed', '--actor', 'director', '--subject', 'ORD-0001', '--payload', '{"from":"verified","to":"closed"}']);
  assert.equal(raw.status, 1);
  assert.match(raw.stdout, /E_TRANSITION/);
  refused(aos(root, ['close', 'ORD-0001', '--as', 'executor']), 'E_RISK_CLOSE');
  refused(aos(root, ['close', 'ORD-0001', '--as', 'owner']), 'E_RISK_CLOSE');
  const ok = aos(root, ['close', 'ORD-0001', '--as', 'director']);
  assert.equal(ok.status, 0, ok.stderr);
  const last = readLog(root).events.at(-1);
  assert.deepEqual([last.actor, last.payload.from, last.payload.to], ['director', 'verified', 'closed']);
  assert.equal(stateOf(root, 'ORD-0001').state, 'closed');
});

test('medium: --as director is refused; the owner closes from a TTY', async () => {
  const root = riskProject([{ id: 'ORD-0001', risk: 'medium' }]);
  assert.equal(aos(root, ['admit', 'ORD-0001']).status, 0);
  deliver(root, 'ORD-0001');
  assert.equal(aos(root, ['verify', 'ORD-0001']).status, 0);
  refused(aos(root, ['close', 'ORD-0001', '--as', 'director']), 'E_RISK_CLOSE');
  refused(aos(root, ['close', 'ORD-0001'], 'CLOSE\n'), 'E_OWNER_TTY');
  await close(root, ['ORD-0001'], { isTTY: true, ask: async () => 'CLOSE' });
  assert.equal(readLog(root).events.at(-1).actor, 'owner');
  assert.equal(stateOf(root, 'ORD-0001').state, 'closed');
});

test('high: run start needs a locked rollback plan (E_NO_ROLLBACK); verify takes two samples; only the owner closes', async () => {
  const missing = riskProject([{ id: 'ORD-0001', risk: 'high', rollback: 'missing' }]);
  assert.equal(aos(missing, ['admit', 'ORD-0001']).status, 0);
  let before = log(missing);
  refused(aos(missing, ['run', 'start', 'ORD-0001']), 'E_NO_ROLLBACK');
  assert.deepEqual(log(missing), before, 'nothing written');

  const unlocked = riskProject([{ id: 'ORD-0001', risk: 'high', rollback: 'unlocked' }]);
  assert.equal(aos(unlocked, ['admit', 'ORD-0001']).status, 0);
  before = log(unlocked);
  const r = aos(unlocked, ['run', 'start', 'ORD-0001']);
  refused(r, 'E_NO_ROLLBACK');
  assert.match(r.stderr, /not listed in \.analucia\/director\.lock/);
  assert.deepEqual(log(unlocked), before);

  const root = riskProject([{ id: 'ORD-0001', risk: 'high', rollback: 'locked' }]);
  assert.equal(aos(root, ['admit', 'ORD-0001']).status, 0);
  deliver(root, 'ORD-0001');
  const v = aos(root, ['verify', 'ORD-0001']);
  assert.equal(v.status, 0, v.stderr);
  const ev = readLog(root).events.find((e) => e.payload.level === 'verified');
  assert.equal(ev.payload.samples, 2);
  assert.deepEqual(ev.payload.checks.map((c) => c.sample), [1, 2]);
  assert.match(readFileSync(join(root, ev.payload.path), 'utf8'), /samples: 2[\s\S]*sample 2, check 1/);
  refused(aos(root, ['close', 'ORD-0001', '--as', 'director']), 'E_RISK_CLOSE');
  await close(root, ['ORD-0001'], { isTTY: true, ask: async () => 'CLOSE' });
  assert.equal(stateOf(root, 'ORD-0001').state, 'closed');
});

test('high: verify fails when the second sample fails (a check that passes once, then fails)', () => {
  const flaky = 'if [ -f .sample-seen ]; then echo second; exit 1; fi; touch .sample-seen; echo first';
  const root = riskProject([{ id: 'ORD-0001', risk: 'high', rollback: 'locked' }], { checks: [{ name: 'flaky', run: flaky, expect_exit: 0 }] });
  assert.equal(aos(root, ['admit', 'ORD-0001']).status, 0);
  deliver(root, 'ORD-0001');
  const v = aos(root, ['verify', 'ORD-0001']);
  refused(v, 'E_VERIFY_FAILED');
  const ev = readLog(root).events.filter((e) => e.payload.level === 'verified').at(-1);
  assert.deepEqual(ev.payload.checks.map((c) => [c.sample, c.passed]), [[1, true], [2, false]]);
  assert.equal(ev.payload.samples, 2);
  assert.equal(stateOf(root, 'ORD-0001').state, 'delivered');
  // The same flaky check passes a single-sample (medium) verify: the second sample is what catches it.
  const medium = riskProject([{ id: 'ORD-0001', risk: 'medium' }], { checks: [{ name: 'flaky', run: flaky, expect_exit: 0 }] });
  assert.equal(aos(medium, ['admit', 'ORD-0001']).status, 0);
  deliver(medium, 'ORD-0001');
  assert.equal(aos(medium, ['verify', 'ORD-0001']).status, 0);
  rmSync(join(medium, '.sample-seen'), { force: true });
});

test('version skew: run start still runs, records version_skew and prints one warning', () => {
  const root = riskProject([{ id: 'ORD-0001', risk: 'low' }, { id: 'ORD-0002', risk: 'low' }]);
  admit(root, 'ORD-0001', { pluginVersion: '0.0.9' });
  const r = aos(root, ['run', 'start', 'ORD-0001']);
  assert.equal(r.status, 0, r.stderr);
  const warnings = r.stdout.split('\n').filter((l) => l.startsWith('warning:'));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /admitted with plugin 0\.0\.9; running with /);
  const started = readLog(root).events.find((e) => e.type === 'run.started');
  assert.deepEqual(started.payload.version_skew, { pinned: '0.0.9', current: currentPluginVersion() });

  assert.equal(aos(root, ['admit', 'ORD-0002']).status, 0);
  const same = aos(root, ['run', 'start', 'ORD-0002']);
  assert.equal(same.status, 0);
  assert.doesNotMatch(same.stdout, /warning:/);
  assert.equal(readLog(root).events.filter((e) => e.type === 'run.started').at(-1).payload.version_skew, undefined);
});

test('rollback plans are protected paths for the PreToolUse hook', () => {
  const root = riskProject([]);
  const hook = (tool, input) => spawnSync(process.execPath, [AOS, 'hook', 'pre-tool-use', '--root', root], { encoding: 'utf8', env, input: JSON.stringify({ tool_name: tool, tool_input: input, cwd: root }) });
  assert.equal(hook('Write', { file_path: '.analucia/rollback/ORD-0001.md', content: 'x' }).status, 2);
  assert.equal(hook('Bash', { command: 'rm .analucia/rollback/ORD-0001.md' }).status, 2);
  assert.equal(hook('Read', { file_path: '.analucia/rollback/ORD-0001.md' }).status, 0);
});
