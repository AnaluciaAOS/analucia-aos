// ORD-0047 part 15 (OBS-200): a test that fails once is named, even if a second pass is clean; the unsteady tests the
// director accepted are in .analucia/flaky.txt, each with a reason; any other unsteady test fails the run.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { judge, parseFlaky } from '../lib/flaky.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const aos = (root, ...args) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8' });

// The suite reads plan.json: { "<test>": [status of pass 1, status of pass 2, …] } and counts its own passes in count.txt.
const SUITE = [
  "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
  "const n = existsSync('count.txt') ? Number(readFileSync('count.txt', 'utf8')) : 0;",
  "writeFileSync('count.txt', String(n + 1));",
  "const plan = JSON.parse(readFileSync('plan.json', 'utf8'));",
  "console.log('TAP version 13');",
  "Object.entries(plan).forEach(([name, st], i) => console.log(`${(st[n] ?? st.at(-1)) === 'fail' ? 'not ok' : 'ok'} ${i + 1} - ${name}`));", ''].join('\n');

function project(plan, flaky) {
  const root = mkdtempSync(join(tmpdir(), 'aos-flaky-'));
  mkdirSync(join(root, '.analucia'), { recursive: true });
  writeFileSync(join(root, '.analucia', 'project.json'), `${JSON.stringify({ wip_limit: 1, locale: 'en', tests: { command: 'node suite.mjs', report: 'tap' } })}\n`);
  writeFileSync(join(root, '.analucia', 'events.jsonl'), '');
  writeFileSync(join(root, 'suite.mjs'), SUITE);
  writeFileSync(join(root, 'plan.json'), JSON.stringify(plan));
  if (flaky !== undefined) writeFileSync(join(root, '.analucia', 'flaky.txt'), flaky);
  return root;
}
const record = (root) => JSON.parse(readFileSync(join(root, '.analucia', 'evidence', 'ORD-0001', 'tests-run.json'), 'utf8'));

test('a test that fails once and then passes is named unsteady and fails the run; the name is in the evidence', () => {
  const root = project({ steady: ['pass'], 'login works': ['fail', 'pass'] });
  const r = aos(root, 'tests', 'run', 'ORD-0001');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /UNSTEADY \(failed once, then passed\): login works/);
  const rec = record(root);
  assert.deepEqual(rec.failed_once, ['login works']);
  assert.deepEqual(rec.unsteady, ['login works']);
  assert.equal(rec.passes, 2);
  assert.equal(rec.ok, false);
});

test('an unsteady test accepted in flaky.txt with a reason passes the run, and is still recorded', () => {
  const root = project({ steady: ['pass'], 'login works': ['fail', 'pass'] }, '# accepted by the director\nlogin works | the clock of the CI machine, ORD-0044\n');
  const r = aos(root, 'tests', 'run', 'ORD-0001');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /unsteady, accepted in \.analucia\/flaky\.txt: login works/);
  assert.deepEqual(record(root).accepted, ['login works']);
});

test('a line of flaky.txt without a reason accepts nothing', () => {
  const root = project({ 'login works': ['fail', 'pass'] }, 'login works\n');
  const r = aos(root, 'tests', 'run', 'ORD-0001');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /listed in flaky\.txt with no reason: login works/);
});

test('a test that fails in every pass is failing, not unsteady; a clean suite runs once', () => {
  const bad = project({ broken: ['fail', 'fail'] }, 'broken | wrongly listed\n');
  const r = aos(bad, 'tests', 'run', 'ORD-0001');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAILING in every pass: broken/);
  const clean = project({ a: ['pass'], b: ['pass'] });
  const c = aos(clean, 'tests', 'run', 'ORD-0001');
  assert.equal(c.status, 0, c.stdout);
  assert.equal(record(clean).passes, 1);
  assert.deepEqual(record(clean).failed_once, []);
});

test('judge and parseFlaky are pure', () => {
  assert.deepEqual(parseFlaky('# c\nx | why\ny\n').accepted.get('x'), 'why');
  assert.deepEqual(parseFlaky('y\n').noReason, ['y']);
  const v = judge([{ a: 'fail', b: 'pass' }, { a: 'pass', b: 'pass' }]);
  assert.deepEqual([v.failing, v.unsteady, v.ok], [[], ['a'], false]);
});
