// ORD-0043 part 18 (AMD-0017 section 4, OBS-181): a run that reaches its cap of parts ends as `parts_cap`, not as
// `budget_exhausted`. The order goes back to the queue like budget_exhausted and the run counts as an attempt; every
// text for a person names it in its own words, in the five locales. budget_exhausted keeps its meaning (the time ran out).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hashLF } from '../lib/lock.mjs';
import { logPath, readLog } from '../lib/log.mjs';
import { catalog } from '../lib/onboarding.mjs';
import { replay } from '../lib/state.mjs';

const read = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env };
delete env.CLAUDE_PROJECT_DIR;
const aos = (root, args) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input: '', env });
const order = (root) => replay(readLog(root).events).orders['ORD-0001'];

function project(attempts = 3) {
  const root = mkdtempSync(join(tmpdir(), 'aos-partscap-'));
  const a = join(root, '.analucia');
  for (const d of ['orders', 'verify', 'evidence', 'rollback']) mkdirSync(join(a, d), { recursive: true });
  mkdirSync(join(root, 'core'));
  writeFileSync(join(root, 'core', 'NOMENCLATURE.md'), '---\nid: SPEC-0001\nversion_approved: 0.0.1\nversion: 0.1.0\n---\n');
  writeFileSync(join(root, 'core', 'SPEC-0002-X.md'), '---\nid: SPEC-0002\nversion: 0.1.0\n---\n');
  writeFileSync(join(root, 'core', 'SPEC-0003-X.md'), '---\nid: SPEC-0003\nversion: 0.2.0\n---\n');
  writeFileSync(join(a, 'project.json'), '{"wip_limit":1,"locale":"en"}\n');
  writeFileSync(logPath(root), '');
  writeFileSync(join(a, 'evidence', 'report.md'), 'evidence\n');
  writeFileSync(join(a, 'orders', 'ORD-0001.md'), ['---', 'id: ORD-0001', 'title: Parts fixture', 'kind: build', 'created: 2026-10-21', 'budget_max_minutes: 60', `budget_max_attempts: ${attempts}`, 'risk: low', 'cost_effect: [build]', '---', '', '# ORD-0001', '', '## Acceptance criteria', '', '- [ ] It works.', ''].join('\n'));
  writeFileSync(join(a, 'verify', 'ORD-0001.json'), `${JSON.stringify({ order: 'ORD-0001', checks: [{ name: 'ok', run: 'exit 0', expect_exit: 0 }] })}\n`);
  const files = { '.analucia/orders/ORD-0001.md': hashLF(readFileSync(join(a, 'orders', 'ORD-0001.md'))), '.analucia/verify/ORD-0001.json': hashLF(readFileSync(join(a, 'verify', 'ORD-0001.json'))) };
  writeFileSync(join(a, 'director.lock'), `${JSON.stringify({ written_by: 'director', files }, null, 2)}\n`);
  assert.equal(aos(root, ['admit', 'ORD-0001']).status, 0);
  return root;
}
const finish = (root, outcome) => aos(root, ['run', 'finish', 'ORD-0001', '--outcome', outcome, '--evidence', '.analucia/evidence/report.md']);

test('parts_cap is a run outcome: it leads to queued, the run counts as an attempt, and the order can start again', () => {
  const root = project(2);
  assert.equal(aos(root, ['run', 'start', 'ORD-0001']).status, 0);
  const f = finish(root, 'parts_cap');
  assert.equal(f.status, 0, f.stderr);
  assert.equal(order(root).state, 'queued');
  assert.equal(order(root).last_outcome, 'parts_cap');
  const ev = readLog(root).events.filter((e) => e.type === 'run.finished').at(-1);
  assert.equal(ev.payload.outcome, 'parts_cap');
  // Run 2 is the last attempt of 2; after it finishes with the cap again, the budget is used up.
  const again = aos(root, ['run', 'start', 'ORD-0001']);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /run 2 of 2/);
  assert.equal(finish(root, 'parts_cap').status, 0);
  const third = aos(root, ['run', 'start', 'ORD-0001']);
  assert.equal(third.status, 1);
  assert.match(third.stderr, /E_BUDGET/);
});

test('budget_exhausted keeps its meaning and an unknown outcome is still refused', () => {
  const root = project();
  assert.equal(aos(root, ['run', 'start', 'ORD-0001']).status, 0);
  const bad = finish(root, 'cap');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /E_OUTCOME_ENUM/);
  assert.match(bad.stderr, /parts_cap/, 'the list of outcomes names it');
  assert.equal(finish(root, 'budget_exhausted').status, 0);
  assert.equal(order(root).last_outcome, 'budget_exhausted');
  assert.equal(order(root).state, 'queued');
});

test('aos next and aos status say it in plain words, in the five locales', () => {
  const root = project();
  assert.equal(aos(root, ['run', 'start', 'ORD-0001']).status, 0);
  assert.equal(finish(root, 'parts_cap').status, 0);
  const next = aos(root, ['next']);
  assert.match(next.stdout, /goes on in a new run: the last run reached its cap of parts, not its time/);
  assert.match(next.stdout, /run start ORD-0001/);
  const chain = aos(root, ['status', 'ORD-0001', '--chain']);
  assert.match(chain.stdout, /parts_cap \(the cap of parts of a run was reached, not its time; the order goes on in a new run\)/);
  const seen = new Set();
  for (const locale of ['en', 'es', 'pt', 'hi', 'zh-Hans']) {
    const t = catalog(locale);
    const word = t('outcome.parts_cap');
    const line = t('next.queued_parts_cap', { id: 'ORD-0001', title: 'X', cmd: 'CMD' });
    assert.ok(word && !word.startsWith('outcome.') && line.includes('ORD-0001') && line.includes('CMD'), locale);
    seen.add(word);
  }
  assert.equal(seen.size, 5, 'each locale has its own words');
});

test('the report template, the rules block and the spec of the outcomes name it', () => {
  assert.match(read('templates/report.md'), /OUTCOME: <done \| blocked \| needs_decision \| budget_exhausted \| parts_cap \| failed>/);
  assert.match(read('core/AGENTS.block.md'), /parts_cap \(the cap of parts of a run\)/);
  assert.ok(JSON.parse(read('core/enums.json')).run_outcomes.includes('parts_cap'));
  assert.match(read('docs/INDEX.md'), /parts_cap/);
});
