// ORD-0040 part 5 (SDG-001, phase 1): every order report has the fixed section "## Evidencia". It is not a gate:
// `aos run finish --outcome done` prints a warning when the report has no such section, and still records the outcome.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PLUGIN_DIR } from '../lib/cli.mjs';
import { blockTemplate } from '../lib/guards.mjs';
import { hasEvidenciaSection } from '../lib/lifecycle.mjs';
import { appendEvent, logPath, readLog } from '../lib/log.mjs';
import { replay } from '../lib/state.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env };
delete env.CLAUDE_PROJECT_DIR;
const aos = (root, args) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input: '', env });

function activeOrder(report) {
  const root = mkdtempSync(join(tmpdir(), 'aos-evid-'));
  const a = join(root, '.analucia');
  for (const d of ['orders', 'evidence/ORD-0001']) mkdirSync(join(a, d), { recursive: true });
  writeFileSync(join(a, 'project.json'), '{"wip_limit":1,"locale":"en"}\n');
  writeFileSync(logPath(root), '');
  writeFileSync(join(a, 'orders', 'ORD-0001.md'), ['---', 'id: ORD-0001', 'title: T', 'kind: fix', 'created: 2026-11-14', 'budget_max_minutes: 30', 'budget_max_attempts: 2', '---', '', '## Acceptance criteria', '', '- [ ] x', ''].join('\n'));
  writeFileSync(join(a, 'evidence', 'ORD-0001', 'report.md'), report);
  appendEvent(root, { type: 'record.created', actor: 'director', subject: 'ORD-0001' });
  appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: 'ORD-0001', payload: { from: 'draft', to: 'ready' } });
  appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: 'ORD-0001', payload: { from: 'ready', to: 'queued' } });
  assert.equal(aos(root, ['run', 'start', 'ORD-0001']).status, 0);
  return root;
}
const finish = (root, outcome) => aos(root, ['run', 'finish', 'ORD-0001', '--outcome', outcome, '--evidence', '.analucia/evidence/ORD-0001/report.md']);
const order = (root) => replay(readLog(root).events).orders['ORD-0001'];

test('the report template and the rules block carry the Evidencia section', () => {
  const template = readFileSync(join(PLUGIN_DIR, 'templates', 'report.md'), 'utf8');
  assert.ok(hasEvidenciaSection(template));
  for (const part of ['Total and base', 'Sample', 'Decision', '## Para el dueño', 'OUTCOME: ']) assert.ok(template.includes(part), part);
  const step3 = blockTemplate().split('\n').find((l) => l.startsWith('3. Evidence:'));
  assert.match(step3, /## Evidencia/);
  assert.match(step3, /templates\/report\.md/);
  assert.equal(hasEvidenciaSection('# r\n\n## Evidencia\r\n\nx\n'), true, 'CRLF');
  assert.equal(hasEvidenciaSection('# r\n\nSee the ## Evidencia section\n### Evidencia\n'), false, 'only a heading line of its own counts');
});

test('done without the section: a warning, never a refusal; the outcome is recorded', () => {
  const root = activeOrder('# report\n\nAll good.\n\nOUTCOME: done\n');
  const r = finish(root, 'done');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ORD-0001: run finished \(done\), evidence attached, active -> delivered$/m);
  assert.match(r.stdout, /^warning: the report \.analucia\/evidence\/ORD-0001\/report\.md has no "## Evidencia" section \(template: .*\/templates\/report\.md\)\. The outcome was recorded all the same\.$/m);
  assert.equal(order(root).state, 'delivered');
  assert.equal(order(root).last_outcome, 'done');
});

test('done with the section, or any other outcome: no warning', () => {
  const withSection = activeOrder('# report\n\n## Evidencia\n\n1. 3 of 3 checks.\n\nWork: complete\nOUTCOME: done\n');
  const a = finish(withSection, 'done');
  assert.equal(a.status, 0);
  assert.doesNotMatch(a.stdout, /warning/);
  assert.equal(order(withSection).state, 'delivered');
  const blocked = activeOrder('# report\n\nStopped.\n\nWork: not complete\nOUTCOME: blocked\n');
  const b = aos(blocked, ['run', 'finish', 'ORD-0001', '--outcome', 'blocked', '--evidence', '.analucia/evidence/ORD-0001/report.md', '--reason', 'waiting']);
  assert.equal(b.status, 0);
  assert.doesNotMatch(b.stdout, /warning/);
  assert.equal(order(blocked).state, 'blocked');
});
