// ORD-0011: absolute export path, stable settings key order, verify progress while it runs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { admit, verify } from '../lib/lifecycle.mjs';
import { hashLF } from '../lib/lock.mjs';
import { appendEvent, logPath } from '../lib/log.mjs';
import { ceoExport } from '../lib/owner-sheet.mjs';
import { ordered, permissionsWrite } from '../lib/permissions.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env };
delete env.CLAUDE_PROJECT_DIR;
const aos = (root, args) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input: '', env });

function minimal() {
  const root = mkdtempSync(join(tmpdir(), 'aos-fix-'));
  mkdirSync(join(root, '.analucia', 'orders'), { recursive: true });
  writeFileSync(join(root, '.analucia', 'project.json'), '{"wip_limit":1}\n');
  writeFileSync(logPath(root), '');
  return root;
}

test('ceo export: an absolute --out is written there; a relative one stays relative to the repo root', () => {
  const root = minimal();
  const elsewhere = mkdtempSync(join(tmpdir(), 'aos-out-'));
  const abs = join(elsewhere, 'nested', 'sheet.xlsx');
  const r = aos(root, ['ceo', 'export', '--out', abs]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(abs), 'written at the absolute path');
  assert.equal(readFileSync(abs).readUInt32LE(0), 0x04034b50);
  assert.ok(!existsSync(join(root, elsewhere.replace(/^[A-Za-z]:/, ''))), 'not re-rooted under the repo');
  ceoExport(root, { out: 'views/rel.xlsx' });
  assert.ok(existsSync(join(root, 'views', 'rel.xlsx')));
});

test('settings.json keys are written in Claude Code order, and a file already in that order is left unchanged', () => {
  const root = minimal();
  mkdirSync(join(root, '.claude'));
  const mp = { name: 'analucia-aos', plugin: 'analucia', repo: 'example/analucia-aos' };
  // Start from the old order (allow, ask, deny; marketplaces before plugins) plus a foreign key.
  writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ extraKnownMarketplaces: {}, model: 'x', permissions: { ask: [], defaultMode: 'default', allow: [], deny: [] }, enabledPlugins: {} }, null, 2));
  permissionsWrite(root, { marketplace: mp });
  const text = readFileSync(join(root, '.claude', 'settings.json'), 'utf8');
  const s = JSON.parse(text);
  assert.deepEqual(Object.keys(s), ['permissions', 'enabledPlugins', 'extraKnownMarketplaces', 'model']);
  assert.deepEqual(Object.keys(s.permissions), ['allow', 'deny', 'ask', 'defaultMode']);
  assert.equal(permissionsWrite(root, { marketplace: mp }).changed, false);
  assert.equal(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'), text, 'byte-identical on a second run');
  // A file written the way Claude Code writes it (same order, 2-space JSON) is not touched.
  writeFileSync(join(root, '.claude', 'settings.json'), `${JSON.stringify(ordered(s), null, 2)}\n`);
  assert.equal(permissionsWrite(root, { marketplace: mp }).changed, false);
  // The real repo's file is already stable.
  const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
  const real = JSON.parse(readFileSync(join(repoRoot, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(Object.keys(real).slice(0, 3), ['permissions', 'enabledPlugins', 'extraKnownMarketplaces']);
  assert.deepEqual(Object.keys(real.permissions).slice(0, 3), ['allow', 'deny', 'ask']);
});

// A delivered order with a locked verify file; `high` adds a locked rollback plan and pins.
function delivered({ risk = null, checks }) {
  const root = minimal();
  const a = join(root, '.analucia');
  for (const d of ['verify', 'rollback', 'evidence']) mkdirSync(join(a, d), { recursive: true });
  mkdirSync(join(root, 'core'));
  writeFileSync(join(root, 'core', 'SPEC-0003-X.md'), '---\nid: SPEC-0003\nversion: 0.1.0\n---\n');
  const keys = risk ? [`risk: ${risk}`, 'cost_effect: none', ...(risk === 'high' ? ['rollback: .analucia/rollback/ORD-0001.md'] : [])] : [];
  writeFileSync(join(a, 'orders', 'ORD-0001.md'), ['---', 'id: ORD-0001', 'title: t', 'kind: fix', 'created: 2026-10-21', 'budget_max_minutes: 30', 'budget_max_attempts: 2', ...keys, '---', '', '## Acceptance criteria', '', '- [ ] x', ''].join('\n'));
  writeFileSync(join(a, 'verify', 'ORD-0001.json'), JSON.stringify({ order: 'ORD-0001', checks }));
  writeFileSync(join(a, 'rollback', 'ORD-0001.md'), '# Rollback\n');
  writeFileSync(join(a, 'evidence', 'r.md'), 'e\n');
  const files = {};
  for (const rel of ['.analucia/orders/ORD-0001.md', '.analucia/verify/ORD-0001.json', '.analucia/rollback/ORD-0001.md']) files[rel] = hashLF(readFileSync(join(root, rel)));
  writeFileSync(join(a, 'director.lock'), JSON.stringify({ files }));
  if (risk) admit(root, 'ORD-0001');
  else {
    appendEvent(root, { type: 'record.created', actor: 'director', subject: 'ORD-0001' });
    appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: 'ORD-0001', payload: { from: 'draft', to: 'ready' } });
    appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: 'ORD-0001', payload: { from: 'ready', to: 'queued' } });
  }
  assert.equal(aos(root, ['run', 'start', 'ORD-0001']).status, 0);
  assert.equal(aos(root, ['run', 'finish', 'ORD-0001', '--outcome', 'done', '--evidence', '.analucia/evidence/r.md']).status, 0);
  return root;
}

test('verify reports each check as it finishes, before the next check runs', () => {
  const root = delivered({ checks: [{ name: 'first', run: 'exit 0', expect_exit: 0 }, { name: 'second', run: 'touch second-ran', expect_exit: 0 }] });
  const seen = [];
  verify(root, 'ORD-0001', {
    onCheck: (c) => seen.push([c.name, c.passed, existsSync(join(root, 'second-ran'))]),
  });
  assert.deepEqual(seen, [['first', true, false], ['second', true, true]], '"first" was reported before "second" started');
});

test('verify CLI prints PASS lines while running, and "sample 1 of 2" / "sample 2 of 2" for high orders', () => {
  const low = delivered({ risk: 'low', checks: [{ name: 'a', run: 'exit 0', expect_exit: 0 }, { name: 'b', run: 'exit 3', expect_exit: 3 }] });
  const r = aos(low, ['verify', 'ORD-0001']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), ['PASS a (exit 0)', 'PASS b (exit 3)', 'ORD-0001: 2 checks passed, evidence .analucia/evidence/ORD-0001/verify-01.txt, delivered -> verified']);
  assert.doesNotMatch(r.stdout, /sample/);

  const high = delivered({ risk: 'high', checks: [{ name: 'a', run: 'exit 0', expect_exit: 0 }] });
  const h = aos(high, ['verify', 'ORD-0001']);
  assert.equal(h.status, 0, h.stderr);
  assert.deepEqual(h.stdout.trim().split('\n').slice(0, 4), ['sample 1 of 2', 'PASS a (exit 0)', 'sample 2 of 2', 'PASS a (exit 0)']);

  const failing = delivered({ checks: [{ name: 'bad', run: 'exit 1', expect_exit: 0 }] });
  const f = aos(failing, ['verify', 'ORD-0001']);
  assert.equal(f.status, 1);
  assert.match(f.stdout, /^FAIL bad \(exit 1, expected 0\)$/m);
  assert.match(f.stderr, /E_VERIFY_FAILED/);
});
