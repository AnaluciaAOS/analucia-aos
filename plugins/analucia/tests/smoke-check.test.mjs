// ORD-0047 part 2 (OBS-204): `aos smoke check <ID>`: a screenshot and a line per screen and button of the key `screens:`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { listDrafts } from '../lib/drafts.mjs';
import { screensOf, smokeCheck, smokeLines } from '../lib/smoke-check.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const order = (id, extra = [], kind = 'build') => ['---', `id: ${id}`, 'title: t', `kind: ${kind}`, 'created: 2026-11-21', 'budget_max_minutes: 30', 'budget_max_attempts: 2', 'risk: low', 'cost_effect: none', 'replaces: []', ...extra, '---', '', '## Business rules', '', '- none', '', '## Acceptance criteria', '', '- [ ] x', ''].join('\n');
const SCREENS = 'screens: [https://site.example/admin/landings|Guardar|Nuevo, https://site.example/admin/menu]';

function project(extra) {
  const root = mkdtempSync(join(tmpdir(), 'aos-smoke-'));
  for (const d of ['orders', 'drafts', 'evidence/ORD-0001']) mkdirSync(join(root, '.analucia', d), { recursive: true });
  writeFileSync(join(root, '.analucia', 'project.json'), '{"wip_limit":1,"locale":"en"}\n');
  writeFileSync(join(root, '.analucia', 'events.jsonl'), '');
  writeFileSync(join(root, '.analucia', 'orders', 'ORD-0001.md'), order('ORD-0001', extra));
  return root;
}
const ev = (root, name) => writeFileSync(join(root, '.analucia', 'evidence', 'ORD-0001', name), 'png');
const smoke = (root, text) => writeFileSync(join(root, '.analucia', 'evidence', 'ORD-0001', 'smoke.md'), text);
const run = (root) => spawnSync(process.execPath, [AOS, 'smoke', 'check', 'ORD-0001', '--root', root], { encoding: 'utf8' });
const FULL = ['# smoke', '- https://site.example/admin/landings | Guardar | the row was saved and listed | a.png', '- https://site.example/admin/landings | Nuevo | the form opened | b.png', '- https://site.example/admin/menu | (open) | the menu shows 8 links | c.png', ''].join('\n');

test('the screens of the key: one entry per button, (open) for a screen without buttons', () => {
  assert.deepEqual(screensOf(order('ORD-0001', [SCREENS])).map((s) => `${s.address} ${s.button}`), [
    'https://site.example/admin/landings Guardar', 'https://site.example/admin/landings Nuevo', 'https://site.example/admin/menu (open)']);
  assert.deepEqual(screensOf(order('ORD-0001')), []);
  assert.equal(smokeLines(FULL).length, 3);
});

test('a screenshot and a line for every button: passes', () => {
  const root = project([SCREENS]);
  smoke(root, FULL);
  for (const f of ['a.png', 'b.png', 'c.png']) ev(root, f);
  const r = run(root);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /smoke check: ok \(3 /);
});

test('a missing screenshot, a missing line, a line that says an error happened: each fails', () => {
  const root = project([SCREENS]);
  smoke(root, FULL);
  ev(root, 'a.png');
  ev(root, 'b.png');
  let r = run(root);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /menu \| \(open\): the screenshot c\.png is not in/);
  ev(root, 'c.png');
  smoke(root, FULL.replace('the row was saved and listed', 'TypeError: cannot read total, the page crashed'));
  r = run(root);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Guardar: the line says an error happened/);
  smoke(root, FULL.split('\n').filter((l) => !l.includes('Nuevo')).join('\n'));
  r = run(root);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Nuevo: no line in smoke\.md/);
  assert.equal(smokeCheck(project([SCREENS]), 'ORD-0001').ok, false); // no smoke.md at all
});

test('an order without the key passes with one line', () => {
  const r = run(project([]));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /has no "screens" key/);
});

test('aos drafts refuses a build or ux draft with screens whose verify file does not run aos smoke check', () => {
  const root = project([]);
  const put = (md, runs) => {
    writeFileSync(join(root, '.analucia', 'drafts', 'ORD-0002.md'), md);
    writeFileSync(join(root, '.analucia', 'drafts', 'ORD-0002.request.md'), '- a point of the request => the draft'), writeFileSync(join(root, '.analucia', 'drafts', 'ORD-0002.json'), `${JSON.stringify({ order: 'ORD-0002', checks: runs.map((r2, i) => ({ name: `c${i}`, run: r2, expect_exit: 0 })) })}\n`);
  };
  put(order('ORD-0002', [SCREENS]), ['exit 0']);
  assert.match(listDrafts(root)[0].problems.join('\n'), /does not run "aos smoke check/);
  put(order('ORD-0002', [SCREENS]), ['node aos.mjs smoke check ORD-0002']);
  assert.doesNotMatch(listDrafts(root)[0].problems.join('\n'), /smoke check/);
  put(order('ORD-0002', [SCREENS], 'fix'), ['exit 0']);
  assert.doesNotMatch(listDrafts(root)[0].problems.join('\n'), /smoke check/);
});
