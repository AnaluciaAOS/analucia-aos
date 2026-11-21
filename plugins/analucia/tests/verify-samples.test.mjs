// ORD-0043 part 17 (AMD-0016 section 4): a high-risk verify runs every check once; only a check that failed is run
// again, once, and its second result is the one that counts. The evidence shows both results, records "samples": 1 and
// the names of the repeated checks, and aos sign prints the mark of a check that passed on the second run. Low and
// medium are unchanged: one run, no repeat.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hashLF } from '../lib/lock.mjs';
import { logPath, readLog } from '../lib/log.mjs';
import { verify } from '../lib/lifecycle.mjs';
import { replay } from '../lib/state.mjs';
import { catalog } from '../lib/onboarding.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env };
delete env.CLAUDE_PROJECT_DIR;
const aos = (root, args) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input: '', env });
const count = (root, name) => {
  try { return readFileSync(join(root, `${name}.count`), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; }
};

// One order ORD-0001 of the given risk, delivered, with these checks. Each check of the fixture can count its runs.
function project(risk, checks) {
  const root = mkdtempSync(join(tmpdir(), 'aos-samples-'));
  const a = join(root, '.analucia');
  for (const d of ['orders', 'verify', 'evidence', 'rollback']) mkdirSync(join(a, d), { recursive: true });
  mkdirSync(join(root, 'core'));
  writeFileSync(join(root, 'core', 'NOMENCLATURE.md'), '---\nid: SPEC-0001\nversion_approved: 0.0.1\nversion: 0.1.0\n---\n');
  writeFileSync(join(root, 'core', 'SPEC-0002-X.md'), '---\nid: SPEC-0002\nversion: 0.1.0\n---\n');
  writeFileSync(join(root, 'core', 'SPEC-0003-X.md'), '---\nid: SPEC-0003\nversion: 0.2.0\n---\n');
  writeFileSync(join(a, 'project.json'), '{"wip_limit":3}\n');
  writeFileSync(logPath(root), '');
  writeFileSync(join(a, 'evidence', 'report.md'), 'evidence\n');
  const keys = [`risk: ${risk}`, 'cost_effect: [build]', ...(risk === 'high' ? ['rollback: .analucia/rollback/ORD-0001.md'] : [])];
  writeFileSync(join(a, 'orders', 'ORD-0001.md'), ['---', 'id: ORD-0001', 'title: Samples fixture', 'kind: build', 'created: 2026-10-21', 'budget_max_minutes: 60', 'budget_max_attempts: 2', ...keys, '---', '', '# ORD-0001', '', '## Acceptance criteria', '', '- [ ] It works.', ''].join('\n'));
  writeFileSync(join(a, 'verify', 'ORD-0001.json'), `${JSON.stringify({ order: 'ORD-0001', checks })}\n`);
  writeFileSync(join(a, 'rollback', 'ORD-0001.md'), '# Rollback\n\n1. git revert the commit.\n2. Check: aos verify.\n');
  const files = {};
  for (const rel of ['.analucia/orders/ORD-0001.md', '.analucia/verify/ORD-0001.json', ...(risk === 'high' ? ['.analucia/rollback/ORD-0001.md'] : [])]) files[rel] = hashLF(readFileSync(join(root, rel)));
  writeFileSync(join(a, 'director.lock'), `${JSON.stringify({ written_by: 'director', files }, null, 2)}\n`);
  assert.equal(aos(root, ['admit', 'ORD-0001']).status, 0);
  assert.equal(aos(root, ['run', 'start', 'ORD-0001']).status, 0);
  assert.equal(aos(root, ['run', 'finish', 'ORD-0001', '--outcome', 'done', '--evidence', '.analucia/evidence/report.md']).status, 0);
  return root;
}
const counting = (name, then) => ({ name, run: `echo x >> ${name}.count; ${then}`, expect_exit: 0 });
const evidenceOf = (root) => readLog(root).events.filter((e) => e.payload?.level === 'verified').at(-1);
const state = (root) => replay(readLog(root).events).orders['ORD-0001'].state;

test('high, all pass: each check runs once, samples 1, nothing repeated', () => {
  const root = project('high', [counting('one', 'exit 0'), counting('two', 'exit 0')]);
  const r = aos(root, ['verify', 'ORD-0001']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(count(root, 'one'), 1);
  assert.equal(count(root, 'two'), 1);
  const ev = evidenceOf(root);
  assert.equal(ev.payload.samples, 1);
  assert.deepEqual(ev.payload.repeated, []);
  assert.equal(state(root), 'verified');
  const text = readFileSync(join(root, ev.payload.path), 'utf8');
  assert.match(text, /risk: high · samples: 1/);
  assert.doesNotMatch(text, /second run/);
});

test('high, one fails twice: the check is run twice, the others once, the result is failed, both runs are in the evidence', () => {
  const root = project('high', [counting('good', 'exit 0'), counting('bad', 'exit 3')]);
  const r = aos(root, ['verify', 'ORD-0001']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /E_VERIFY_FAILED/);
  assert.equal(count(root, 'good'), 1);
  assert.equal(count(root, 'bad'), 2);
  const ev = evidenceOf(root);
  assert.equal(ev.payload.samples, 1);
  assert.deepEqual(ev.payload.repeated, ['bad']);
  const bad = ev.payload.checks.find((c) => c.name === 'bad');
  assert.deepEqual([bad.passed, bad.exit, bad.first_exit, bad.passed_on_second_run], [false, 3, 3, undefined]);
  assert.equal(state(root), 'delivered');
  const text = readFileSync(join(root, ev.payload.path), 'utf8');
  assert.match(text, /check 2: bad[\s\S]*second run, check 2: bad/);
  assert.match(text, /failed on both runs: bad/);
});

test('high, one fails then passes: passed, marked "passed on the second run", the second result counts', () => {
  const flaky = 'if [ -f .seen ]; then exit 0; fi; touch .seen; exit 1';
  const root = project('high', [counting('good', 'exit 0'), counting('flaky', flaky)]);
  const r = aos(root, ['verify', 'ORD-0001']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PASS \[passed on the second run\] flaky/);
  assert.equal(count(root, 'good'), 1);
  assert.equal(count(root, 'flaky'), 2);
  const ev = evidenceOf(root);
  assert.deepEqual(ev.payload.repeated, ['flaky']);
  const f = ev.payload.checks.find((c) => c.name === 'flaky');
  assert.deepEqual([f.passed, f.first_exit, f.exit, f.passed_on_second_run], [true, 1, 0, true]);
  assert.equal(ev.payload.checks.find((c) => c.name === 'good').passed_on_second_run, undefined);
  assert.equal(state(root), 'verified');
  assert.match(readFileSync(join(root, ev.payload.path), 'utf8'), /passed on the second run: flaky \(the first run exited 1, expected 0\)/);
});

test('low and medium are unchanged: one run per check, a failed check is not repeated', () => {
  for (const risk of ['low', 'medium']) {
    const root = project(risk, [counting('good', 'exit 0'), counting('bad', 'exit 1')]);
    const r = aos(root, ['verify', 'ORD-0001']);
    assert.equal(r.status, 1, risk);
    assert.equal(count(root, 'good'), 1, risk);
    assert.equal(count(root, 'bad'), 1, risk);
    const ev = evidenceOf(root);
    assert.equal(ev.payload.samples, 1);
    assert.deepEqual(ev.payload.repeated, []);
  }
});

test('aos sign prints the mark of a check that passed on the second run, in every language', () => {
  for (const locale of ['en', 'es', 'pt', 'hi', 'zh-Hans']) {
    const line = catalog(locale)('sign.check_pass_second', { name: 'flaky' });
    assert.ok(line.includes('flaky') && line !== catalog(locale)('sign.check_pass', { name: 'flaky' }), locale);
  }
  const root = project('high', [counting('flaky', 'if [ -f .seen ]; then exit 0; fi; touch .seen; exit 1')]);
  const shown = [];
  verify(root, 'ORD-0001', { onCheck: (c) => shown.push(c) });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].passed_on_second_run, true);
});
