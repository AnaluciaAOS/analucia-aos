// ORD-0043 part 8 (OBS-150): `aos validate` no longer prints the warnings that belong to a closed order; its closing
// line counts them. `aos validate --detail` prints them as before. Errors are always printed; the exit code is the same.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hashLF } from '../lib/lock.mjs';
import { appendEvent, logPath } from '../lib/log.mjs';
import { LOCALES } from '../lib/onboarding.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env, LC_ALL: 'en_US.UTF-8' };
delete env.CLAUDE_PROJECT_DIR;
const aos = (root, args) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { cwd: root, encoding: 'utf8', env });
const MOVING = [{ name: 'x', run: 'git diff --quiet 8ea118d HEAD -- core', expect_exit: 0 }];
const CLEAN = [{ name: 'x', run: 'node -e 0', expect_exit: 0 }];

// A scratch project. Each order: { id, checks, state: 'queued' | 'closed' }, admitted with old pins (so that a
// moving ref in its verify file is a warning, not an error).
function project(orders) {
  const root = mkdtempSync(join(tmpdir(), 'aos-quiet-'));
  const a = join(root, '.analucia');
  for (const d of ['orders', 'verify']) mkdirSync(join(a, d), { recursive: true });
  writeFileSync(join(a, 'project.json'), '{"wip_limit":3}\n');
  writeFileSync(logPath(root), '');
  const files = {};
  for (const o of orders) {
    writeFileSync(join(a, 'orders', `${o.id}.md`), ['---', `id: ${o.id}`, 'title: Quiet fixture', 'kind: build', 'created: 2026-11-08',
      'budget_max_minutes: 60', 'budget_max_attempts: 2', 'risk: low', 'cost_effect: [build]', '---', '', `# ${o.id}`, '', '## Acceptance criteria', '', '- [ ] It works.', ''].join('\n'));
    writeFileSync(join(a, 'verify', `${o.id}.json`), `${JSON.stringify({ order: o.id, checks: o.checks }, null, 2)}\n`);
    for (const rel of [`.analucia/orders/${o.id}.md`, `.analucia/verify/${o.id}.json`]) files[rel] = hashLF(readFileSync(join(root, rel)));
  }
  writeFileSync(join(a, 'director.lock'), `${JSON.stringify({ written_by: 'director', files }, null, 2)}\n`);
  const step = (id, actor, from, to) => appendEvent(root, { type: 'order.state_changed', actor, subject: id, payload: { from, to } });
  for (const o of orders) {
    appendEvent(root, { type: 'record.created', actor: 'director', subject: o.id, payload: { pins: { plugin: '0.2.0', specs: {} } } });
    step(o.id, 'director', 'draft', 'ready');
    step(o.id, 'director', 'ready', 'queued');
    if (o.state === 'closed') {
      step(o.id, 'executor', 'queued', 'active');
      appendEvent(root, { type: 'run.started', actor: 'executor', subject: o.id, payload: { run: 1 } });
      appendEvent(root, { type: 'run.finished', actor: 'executor', subject: o.id, payload: { run: 1, outcome: 'done' } });
      step(o.id, 'executor', 'active', 'delivered');
      step(o.id, 'system', 'delivered', 'verified');
      step(o.id, 'owner', 'verified', 'closed');
    }
  }
  return root;
}

test('a warning of a closed order is not printed; the closing line counts it; --detail prints it as before', () => {
  const root = project([{ id: 'ORD-0001', checks: MOVING, state: 'closed' }, { id: 'ORD-0002', checks: MOVING, state: 'closed' }, { id: 'ORD-0003', checks: CLEAN, state: 'queued' }]);
  const r = aos(root, ['validate']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /E_MOVING_REF/);
  assert.doesNotMatch(r.stdout, /^warning:/m);
  assert.equal(r.stdout.trimEnd().split('\n').length, 1, 'only the closing line');
  assert.match(r.stdout, /^OK: .*\(0 errors, 0 warnings; 2 warnings of closed orders not shown\)\n$/);
  const d = aos(root, ['validate', '--detail']);
  assert.equal(d.status, 0);
  assert.equal(d.stdout.match(/^warning: .*E_MOVING_REF/gm).length, 2);
  assert.match(d.stdout.trimEnd().split('\n').at(-1), /^OK: .*\(0 errors, 2 warnings\)$/);
});

test('a warning of an order that is not closed is still printed, next to the count of the hidden ones', () => {
  const root = project([{ id: 'ORD-0001', checks: MOVING, state: 'closed' }, { id: 'ORD-0002', checks: MOVING, state: 'queued' }]);
  const r = aos(root, ['validate']);
  assert.equal(r.status, 0, r.stdout);
  const warnings = r.stdout.match(/^warning: .*E_MOVING_REF/gm);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ORD-0002\.json/);
  assert.match(r.stdout.trimEnd().split('\n').at(-1), /^OK: .*\(0 errors, 1 warnings; 1 warnings of closed orders not shown\)$/);
});

test('with no warning of a closed order the closing line is the one of before', () => {
  const root = project([{ id: 'ORD-0001', checks: CLEAN, state: 'closed' }]);
  const r = aos(root, ['validate']);
  assert.equal(r.stdout, 'OK: the project files are valid (0 errors, 0 warnings)\n');
});

test('errors are always printed and the exit code does not change, a closed order included', () => {
  const root = project([{ id: 'ORD-0001', checks: MOVING, state: 'closed' }, { id: 'ORD-0002', checks: CLEAN, state: 'closed' }]);
  // An error in the file of a closed order: an unknown key in its verify file.
  writeFileSync(join(root, '.analucia', 'verify', 'ORD-0002.json'), `${JSON.stringify({ order: 'ORD-0002', checks: CLEAN, surprise: 1 }, null, 2)}\n`);
  const r = aos(root, ['validate']);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /ORD-0002\.json:\d+: E_/);
  assert.doesNotMatch(r.stdout, /^warning:/m);
  assert.doesNotMatch(r.stdout, /^OK: /m);
  assert.equal(aos(root, ['validate', '--detail']).status, 1);
});

test('the closing line with the count exists in the five catalogs', () => {
  for (const l of LOCALES) {
    const s = JSON.parse(readFileSync(fileURLToPath(new URL(`../i18n/${l}.json`, import.meta.url)), 'utf8')).strings['ok.validate_hidden'];
    assert.ok(s && s.includes('{hidden}') && s.includes('{warnings}') && s.includes('{errors}'), l);
  }
});
