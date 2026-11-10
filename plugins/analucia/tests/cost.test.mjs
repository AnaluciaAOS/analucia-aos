// SPEC-0003 §6: cost records, alerts at 50/80/100 % (once each per month, never blocking), cost per closed order.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildViews } from '../lib/derive.mjs';
import { costRecord } from '../lib/cost.mjs';
import { close } from '../lib/lifecycle.mjs';
import { appendEvent, logPath, readLog } from '../lib/log.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env };
delete env.CLAUDE_PROJECT_DIR;
const aos = (root, args) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input: '', env });

function costProject(project = { wip_limit: 1, budget_monthly_usd: 100 }) {
  const root = mkdtempSync(join(tmpdir(), 'aos-cost-'));
  mkdirSync(join(root, '.analucia', 'orders'), { recursive: true });
  mkdirSync(join(root, '.analucia', 'evidence'), { recursive: true });
  writeFileSync(join(root, '.analucia', 'project.json'), `${JSON.stringify(project)}\n`);
  writeFileSync(logPath(root), '');
  writeFileSync(join(root, '.analucia', 'evidence', 'report.md'), 'evidence\n');
  return root;
}
const alerts = (root) => readLog(root).events.filter((e) => e.payload?.operation === 'cost_alert').map((e) => [e.payload.month, e.payload.threshold]);
const OCT = '2026-10';

test('alerts at 50, 80 and 100 fire once each, print a next (owner) line, and every exit code stays 0', () => {
  const root = costProject();
  const steps = [[30, []], [25, [50]], [10, []], [20, [80]], [20, [100]], [5, []], [50, []]];
  for (const [usd, expected] of steps) {
    const r = aos(root, ['cost', 'record', '--usd', String(usd), '--source', 'provider invoice', '--month', OCT]);
    assert.equal(r.status, 0, r.stderr);
    const fired = [...r.stdout.matchAll(/cost alert: .* crossed (\d+)%/g)].map((m) => Number(m[1]));
    assert.deepEqual(fired, expected, `after +${usd}`);
    if (expected.length) assert.match(r.stdout, /\n {2}next \(owner\): Review the month with "aos cost status".*nothing was stopped or cut\./);
  }
  assert.deepEqual(alerts(root), [[OCT, 50], [OCT, 80], [OCT, 100]]);
  const alert100 = readLog(root).events.find((e) => e.payload.threshold === 100).payload;
  assert.deepEqual(alert100, { operation: 'cost_alert', threshold: 100, month: OCT, spent_usd: 105, budget_usd: 100 });
  // Alerts never change other commands' exit codes.
  for (const args of [['validate'], ['verify-log'], ['derive'], ['check-writeback'], ['cost', 'status', '--month', OCT]]) assert.equal(aos(root, args).status, 0, args.join(' '));
  writeFileSync(join(root, '.analucia', 'orders', 'ORD-0001.md'), '---\nid: ORD-0001\ntitle: t\nkind: build\ncreated: 2026-10-21\nbudget_max_minutes: 30\nbudget_max_attempts: 2\n---\n\n## Acceptance criteria\n\n- [ ] x\n');
  appendEvent(root, { type: 'record.created', actor: 'director', subject: 'ORD-0001' });
  appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: 'ORD-0001', payload: { from: 'draft', to: 'ready' } });
  appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: 'ORD-0001', payload: { from: 'ready', to: 'queued' } });
  assert.equal(aos(root, ['run', 'start', 'ORD-0001']).status, 0, 'work is never stopped by a cost alert');
});

test('one record can cross several thresholds; a new month starts over; no budget means no alerts', () => {
  const root = costProject();
  const r = costRecord(root, { usd: 120, source: 'meter', month: OCT });
  assert.deepEqual(r.fired, [50, 80, 100]);
  assert.deepEqual(costRecord(root, { usd: 60, source: 'meter', month: '2026-11' }).fired, [50]);
  assert.deepEqual(alerts(root), [[OCT, 50], [OCT, 80], [OCT, 100], ['2026-11', 50]]);

  const none = costProject({ wip_limit: 1 });
  const s = aos(none, ['cost', 'record', '--usd', '1000', '--source', 'meter', '--month', OCT]);
  assert.equal(s.status, 0);
  assert.doesNotMatch(s.stdout, /cost alert/);
  assert.deepEqual(alerts(none), []);
  const st = aos(none, ['cost', 'status', '--month', OCT]);
  assert.equal(st.status, 0);
  assert.match(st.stdout, /^Budget 2026-10: not set \(no budget_monthly_usd in \.analucia\/project\.json\); no alerts apply/);
  assert.match(st.stdout, /Spend 2026-10: \$1000\.00 USD in 1 record\(s\)/);
  assert.doesNotMatch(buildViews(none).resume, /^Budget /m, 'no budget: resume.md unchanged');
});

test('cost per closed order counts orders closed in that month and still closed', async () => {
  const root = costProject({ wip_limit: 3, budget_monthly_usd: 200, budget_currency: 'USD' });
  const at = (d) => new Date(`${d}T12:00:00-05:00`);
  for (const id of ['ORD-0001', 'ORD-0002', 'ORD-0003']) {
    writeFileSync(join(root, '.analucia', 'orders', `${id}.md`), `---\nid: ${id}\ntitle: t\nkind: build\ncreated: 2026-10-01\nbudget_max_minutes: 30\nbudget_max_attempts: 2\n---\n\n## Acceptance criteria\n\n- [ ] x\n`);
    for (const [type, actor, payload] of [
      ['record.created', 'director', {}], ['order.state_changed', 'director', { from: 'draft', to: 'ready' }],
      ['order.state_changed', 'director', { from: 'ready', to: 'queued' }], ['order.state_changed', 'executor', { from: 'queued', to: 'active' }],
      ['run.started', 'executor', { run: 1 }], ['run.finished', 'executor', { run: 1, outcome: 'done' }],
      ['order.state_changed', 'executor', { from: 'active', to: 'delivered' }], ['order.state_changed', 'system', { from: 'delivered', to: 'verified' }],
    ]) appendEvent(root, { type, actor, subject: id, payload }, { now: at('2026-09-28') });
  }
  await close(root, ['ORD-0001', 'ORD-0002'], { isTTY: true, ask: async () => 'CLOSE', now: at('2026-10-10') });
  await close(root, ['ORD-0003'], { isTTY: true, ask: async () => 'CLOSE', now: at('2026-11-02') });
  costRecord(root, { usd: 30, source: 'cloud', order: 'ORD-0001', month: OCT, now: at('2026-10-11') });
  costRecord(root, { usd: 20.5, source: 'ci minutes', month: OCT, now: at('2026-10-12') });
  const st = aos(root, ['cost', 'status', '--month', OCT]);
  assert.equal(st.status, 0, st.stderr);
  assert.match(st.stdout, /Budget 2026-10: \$200\.00 USD/);
  assert.match(st.stdout, /Spend 2026-10: \$50\.50 USD in 2 record\(s\) · 25% of budget/);
  assert.match(st.stdout, /Alerts crossed: none/);
  assert.match(st.stdout, /Closed orders 2026-10: 2 \(ORD-0001, ORD-0002\) · cost per closed order \$25\.25/);
  const resume = buildViews(root).resume.split('\n');
  assert.match(resume[0], /^Status: /);
  assert.equal(resume[1], 'Budget 2026-10: $50.50 of $200.00 (25%) · cost per closed order $25.25');
  const nov = aos(root, ['cost', 'status', '--month', '2026-11']);
  assert.match(nov.stdout, /Closed orders 2026-11: 1 \(ORD-0003\) · cost per closed order \$0\.00/);
});

test('cost record refuses bad input with the next line, and writes nothing', () => {
  const root = costProject();
  const before = readFileSync(logPath(root));
  for (const [args, code] of [
    [['--usd', 'ten', '--source', 's'], 'E_FIELD_TYPE'],
    [['--usd', '-1', '--source', 's'], 'E_FIELD_TYPE'],
    [['--usd', '5'], 'E_MISSING_FIELD'],
    [['--usd', '5', '--source', 's', '--month', '2026-13'], 'E_FIELD_TYPE'],
    [['--usd', '5', '--source', 's', '--order', 'ORD-0042'], 'E_NO_ORDER'],
  ]) {
    const r = aos(root, ['cost', 'record', ...args]);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, new RegExp(`aos cost record: ${code} [^\\n]*\\n {2}next \\(`));
  }
  assert.deepEqual(readFileSync(logPath(root)), before);
  assert.equal(aos(root, ['cost', 'status']).status, 0);
});
