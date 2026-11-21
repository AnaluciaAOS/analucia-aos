// ORD-0042 part 7 (OBS-149): an order says what it replaces. The key `replaces:` is an inline list of paths of the
// project that the work of the order replaces and that must be gone when it is delivered (`[]` says, on purpose,
// that it replaces nothing). `aos replaced check <ID>`: at the commit of the order every such path no longer exists.
// `aos drafts` asks for the key in a draft of kind build; placed orders and `aos validate` are not affected.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { listDrafts } from '../lib/drafts.mjs';
import { appendEvent, logPath } from '../lib/log.mjs';
import { replacedCheck } from '../lib/replaces.mjs';
import { validateOrderText } from '../lib/validate.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
delete env.CLAUDE_PROJECT_DIR;
delete env.CLAUDE_CODE_SESSION_ID;
const aos = (root, args) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input: '', env });
const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' });
const order = (id, { kind = 'build', extra = [], rules = true } = {}) => ['---', `id: ${id}`, `title: Title of ${id}`, `kind: ${kind}`, 'created: 2026-11-16', 'budget_max_minutes: 30', 'budget_max_attempts: 2', 'risk: low', 'cost_effect: none', ...extra, '---', '', 'Work.', '', ...(rules ? ['## Business rules', '', '- none', ''] : []), '## Acceptance criteria', '', '- [ ] x', ''].join('\n');
const verifyFile = (id) => `${JSON.stringify({ order: id, checks: [{ name: 'c', run: 'exit 0', expect_exit: 0 }] })}\n`;
const write = (root, rel, text = 'x\n') => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };

function project() {
  const root = mkdtempSync(join(tmpdir(), 'aos-replaces-'));
  for (const d of ['orders', 'verify', 'drafts']) mkdirSync(join(root, '.analucia', d), { recursive: true });
  writeFileSync(join(root, '.analucia', 'project.json'), '{"wip_limit":1,"locale":"en"}\n');
  writeFileSync(logPath(root), '');
  write(root, 'src/pages/old-prices.js');
  write(root, 'src/pages/old-stock.js');
  write(root, 'src/legacy/report/a.js');
  write(root, 'src/legacy/report/b.js');
  write(root, 'src/keep.js');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  return root;
}
const place = (root, id, text) => {
  writeFileSync(join(root, '.analucia', 'orders', `${id}.md`), text);
  appendEvent(root, { type: 'record.created', actor: 'director', subject: id });
};
const commit = (root, message) => { git(root, 'add', '-A'); assert.equal(git(root, 'commit', '-q', '-m', message).status, 0); };

test('replaces: is an inline list of paths of the project; [] is a valid answer; aos validate asks for nothing', () => {
  const codes = (extra) => validateOrderText(order('ORD-0001', { extra }), 'ORD-0001.md', { pinned: true }).map((e) => e.code);
  assert.deepEqual(codes(['replaces: [src/pages/old-prices.js, src/legacy/report]']), []);
  assert.deepEqual(codes(['replaces: []']), []);
  assert.deepEqual(codes([]), [], 'a placed order never needs the key');
  assert.deepEqual(codes(['replaces: src/pages/old-prices.js']), ['E_FIELD_TYPE'], 'a list, not one value');
  assert.deepEqual(codes(['replaces: [../outside.js]']), ['E_FIELD_TYPE']);
  assert.deepEqual(codes(['replaces: [/abs/path.js]']), ['E_FIELD_TYPE']);
});

test('aos drafts asks for it: a draft of kind build without the key is not ready, and the reason says what to write', () => {
  const root = project();
  writeFileSync(join(root, '.analucia', 'drafts', 'ORD-0001.md'), order('ORD-0001'));
  writeFileSync(join(root, '.analucia', 'drafts', 'ORD-0001.json'), verifyFile('ORD-0001'));
  const d = listDrafts(root)[0];
  assert.equal(d.ok, false);
  assert.match(d.problems.join('\n'), /E_MISSING_FIELD .*build.* does not say what it replaces: list the paths in "replaces: \[…\]", or write "replaces: \[\]"/);
  assert.equal(aos(root, ['drafts']).status, 1);
  // With the list, or with the empty list on purpose: ready.
  for (const extra of [['replaces: [src/pages/old-prices.js]'], ['replaces: []']]) {
    writeFileSync(join(root, '.analucia', 'drafts', 'ORD-0001.md'), order('ORD-0001', { extra }));
    assert.deepEqual(listDrafts(root)[0].problems, [], extra[0]);
  }
  // Another kind is not asked.
  writeFileSync(join(root, '.analucia', 'drafts', 'ORD-0001.md'), order('ORD-0001', { kind: 'fix' }));
  assert.deepEqual(listDrafts(root)[0].problems, []);
});

test('aos replaced check: at the commit of the order every replaced path is gone; otherwise exit 1 with what is still there', () => {
  const root = project();
  place(root, 'ORD-0001', order('ORD-0001', { extra: ['replaces: [src/pages/old-prices.js, src/pages/old-stock.js, src/legacy/report]'] }));
  // The work: the new screen is built, one old file is removed, the others are left behind.
  write(root, 'src/pages/prices.js');
  rmSync(join(root, 'src/pages/old-prices.js'));
  commit(root, 'the new screen\n\nAnalucia-Order: ORD-0001');
  const bad = aos(root, ['replaced', 'check', 'ORD-0001']);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /2 of 3 replaced path\(s\) are still there/);
  assert.match(bad.stdout, /^ {2}- src\/legacy\/report$/m);
  assert.match(bad.stdout, /^ {2}- src\/pages\/old-stock\.js$/m);
  assert.doesNotMatch(bad.stdout, /old-prices/);
  assert.deepEqual(replacedCheck(root, 'ORD-0001').still, ['src/legacy/report', 'src/pages/old-stock.js']);
  // Removed in a later commit of the order: the check looks at the newest commit of the order.
  rmSync(join(root, 'src/pages/old-stock.js'));
  rmSync(join(root, 'src/legacy'), { recursive: true });
  commit(root, 'the old sections are gone\n\nAnalucia-Order: ORD-0001');
  const ok = aos(root, ['replaced', 'check', 'ORD-0001']);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout.trimEnd().split('\n').at(-1), /^OK: the 3 path\(s\) ORD-0001 replaces are gone at [0-9a-f]{7,}/);
  // A file deleted only in the working tree, not in a commit of the order, is still there.
  place(root, 'ORD-0002', order('ORD-0002', { extra: ['replaces: [src/keep.js]'] }));
  write(root, 'src/more.js');
  commit(root, 'more\n\nAnalucia-Order: ORD-0002');
  rmSync(join(root, 'src/keep.js'));
  assert.equal(aos(root, ['replaced', 'check', 'ORD-0002']).status, 1);
});

test('with no key or an empty list it exits 0 and says so in one line; an order that is not one is an error', () => {
  const root = project();
  place(root, 'ORD-0001', order('ORD-0001'));
  place(root, 'ORD-0002', order('ORD-0002', { extra: ['replaces: []'] }));
  const none = aos(root, ['replaced', 'check', 'ORD-0001']);
  assert.equal(none.status, 0);
  assert.equal(none.stdout, 'OK: ORD-0001 does not say what it replaces (no "replaces:" key); nothing to check\n');
  const empty = aos(root, ['replaced', 'check', 'ORD-0002']);
  assert.equal(empty.status, 0);
  assert.equal(empty.stdout, 'OK: ORD-0002 replaces nothing ("replaces: []"); nothing to check\n');
  const unknown = aos(root, ['replaced', 'check', 'ORD-0009']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /E_NO_ORDER/);
  assert.equal(aos(root, ['replaced', 'check']).status, 2);
  // A list, but no commit of the order yet: it cannot be judged, and that is an error, not a pass.
  place(root, 'ORD-0003', order('ORD-0003', { extra: ['replaces: [src/keep.js]'] }));
  const early = aos(root, ['replaced', 'check', 'ORD-0003']);
  assert.equal(early.status, 1);
  assert.match(early.stderr, /E_NO_ORDER_COMMIT/);
});

test('the director entrypoint says it in one sentence', () => {
  const entry = readFileSync(fileURLToPath(new URL('../templates/director-entry.md', import.meta.url)), 'utf8');
  const line = entry.split('\n').find((l) => /replaces:/.test(l) && /replaced check/.test(l));
  assert.ok(line);
  assert.match(line, /screen or a module/);
  assert.match(line, /deleted/);
});
