// ORD-0047 part 3 (OBS-205): "not worse than before": a test that passed in the baseline and fails now fails the check, wherever it is.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compareTests, parseJunit, parseTap } from '../lib/not-worse.mjs';
import { validateProjectText } from '../lib/validate.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const aos = (root, ...args) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8' });

const TAP_SUITE = [
  "import { readFileSync } from 'node:fs';",
  "const failing = readFileSync('state.txt', 'utf8').split('\\n').filter(Boolean);",
  "console.log('TAP version 13');",
  "['admin menu has 7 links', 'prices rounding', 'login works'].forEach((n, i) => console.log(`${failing.includes(n) ? 'not ok' : 'ok'} ${i + 1} - ${n}`));",
  'process.exitCode = failing.length ? 1 : 0;', ''].join('\n');
const JUNIT_SUITE = [
  "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
  "const failing = readFileSync('state.txt', 'utf8').split('\\n').filter(Boolean);",
  "mkdirSync('out', { recursive: true });",
  "const cases = ['a & b', 'c'].map((n) => `<testcase classname=\"s\" name=\"${n.replace('&', '&amp;')}\">${failing.includes(n) ? '<failure message=\"x\"/>' : ''}</testcase>`).join('');",
  "writeFileSync('out/junit.xml', `<testsuite>${cases}</testsuite>`);", ''].join('\n');

// A scratch project whose "tests" are a script that prints TAP (or writes JUnit); `state.txt` lists the tests that fail.
function project(report = 'tap', suite = TAP_SUITE) {
  const root = mkdtempSync(join(tmpdir(), 'aos-notworse-'));
  mkdirSync(join(root, '.analucia'), { recursive: true });
  writeFileSync(join(root, '.analucia', 'project.json'), `${JSON.stringify({ wip_limit: 1, locale: 'en', tests: { command: 'node suite.mjs', report } })}\n`);
  writeFileSync(join(root, '.analucia', 'events.jsonl'), '');
  writeFileSync(join(root, 'state.txt'), '');
  writeFileSync(join(root, 'suite.mjs'), suite);
  return root;
}
const setFailing = (root, names) => writeFileSync(join(root, 'state.txt'), names.join('\n'));

test('baseline records every test; compare fails on a test that went from passing to failing, naming it', () => {
  const root = project();
  const b = aos(root, 'tests', 'baseline', 'ORD-0001');
  assert.equal(b.status, 0, b.stdout);
  assert.match(b.stdout, /3 test\(s\) recorded/);
  const saved = JSON.parse(readFileSync(join(root, '.analucia/evidence/ORD-0001/tests-baseline.json'), 'utf8'));
  assert.deepEqual(saved.tests, { 'admin menu has 7 links': 'pass', 'prices rounding': 'pass', 'login works': 'pass' });
  assert.equal(aos(root, 'tests', 'compare', 'ORD-0001').status, 0);
  setFailing(root, ['admin menu has 7 links']); // a test the order did not touch
  const c = aos(root, 'tests', 'compare', 'ORD-0001');
  assert.equal(c.status, 1);
  assert.match(c.stdout, /WORSE: passed in the baseline, fails now: admin menu has 7 links/);
});

test('a test that already failed in the baseline is listed apart and does not fail the check', () => {
  const root = project();
  setFailing(root, ['prices rounding']);
  const b = aos(root, 'tests', 'baseline', 'ORD-0001');
  assert.equal(b.status, 0);
  assert.match(b.stdout, /already failing: prices rounding/);
  const c = aos(root, 'tests', 'compare', 'ORD-0001');
  assert.equal(c.status, 0, c.stdout);
  assert.match(c.stdout, /failed before and still listed apart: prices rounding/);
  setFailing(root, ['prices rounding', 'login works']);
  assert.equal(aos(root, 'tests', 'compare', 'ORD-0001').status, 1);
});

test('compare without a baseline, and a project without the key, say what to do', () => {
  const root = project();
  const c = aos(root, 'tests', 'compare', 'ORD-0001');
  assert.equal(c.status, 1);
  assert.match(c.stdout, /aos tests baseline ORD-0001/);
  const bare = mkdtempSync(join(tmpdir(), 'aos-notworse-'));
  mkdirSync(join(bare, '.analucia'));
  writeFileSync(join(bare, '.analucia', 'project.json'), '{"wip_limit":1}\n');
  assert.match(aos(bare, 'tests', 'baseline', 'ORD-0001').stdout, /no "tests" key/);
});

test('JUnit: the report is a file the command writes', () => {
  const root = project('junit:out/junit.xml', JUNIT_SUITE);
  assert.equal(aos(root, 'tests', 'baseline', 'ORD-0001').status, 0);
  setFailing(root, ['a & b']);
  const c = aos(root, 'tests', 'compare', 'ORD-0001');
  assert.equal(c.status, 1);
  assert.match(c.stdout, /s > a & b/);
  assert.ok(existsSync(join(root, '.analucia/evidence/ORD-0001/tests-baseline.json')));
});

test('the parsers and the comparison', () => {
  const tap = ['TAP version 13', '# Subtest: group', '    # Subtest: inner', '    ok 1 - inner', '    1..1', 'ok 1 - group', 'not ok 2 - broken', 'ok 3 - later # SKIP', 'ok 4 - dup', 'ok 5 - dup'].join('\n');
  assert.deepEqual(parseTap(tap), { 'group > inner': 'pass', group: 'pass', broken: 'fail', later: 'skip', dup: 'pass', 'dup #2': 'pass' });
  assert.deepEqual(parseJunit('<testsuite><testcase classname="a" name="x"/><testcase name="y"><skipped/></testcase><testcase name="z"><error/></testcase></testsuite>'), { 'a > x': 'pass', y: 'skip', z: 'fail' });
  assert.deepEqual(compareTests({ a: 'pass', b: 'fail', c: 'pass', d: 'pass' }, { a: 'fail', b: 'fail', c: 'pass' }), { worse: ['a'], alreadyFailing: ['b'], missing: ['d'] });
});

test('project.json: the "tests" key is validated', () => {
  const v = (tests) => validateProjectText(`${JSON.stringify({ wip_limit: 1, tests })}\n`).map((e) => e.code);
  assert.deepEqual(v({ command: 'node --test', report: 'tap' }), []);
  assert.deepEqual(v({ command: 'x', report: 'junit:out/r.xml' }), []);
  assert.deepEqual(v({ command: 'x', report: 'xml' }), ['E_FIELD_TYPE']);
  assert.deepEqual(v({ report: 'tap' }), ['E_FIELD_TYPE']);
  assert.deepEqual(v('node --test'), ['E_FIELD_TYPE']);
});
