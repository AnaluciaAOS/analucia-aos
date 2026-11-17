// ORD-0041 part 4 (AMD-0015 §4): preflight. A verify file may carry `preflight`, checks meant to pass on the untouched
// tree before any work. `aos preflight <ID>` runs them and changes no state (a placed order or a draft); `aos admit`
// runs them and refuses when one fails; `aos run start` runs them again and, when one fails, starts nothing: no
// run.started, no attempt consumed. A verify file without `preflight` is valid and is admitted as before.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { listDrafts } from '../lib/drafts.mjs';
import { hashLF } from '../lib/lock.mjs';
import { logPath, readLog } from '../lib/log.mjs';
import { sign } from '../lib/sign.mjs';
import { replay } from '../lib/state.mjs';
import { validateVerifyText } from '../lib/validate.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
delete env.CLAUDE_PROJECT_DIR;
delete env.CLAUDE_CODE_SESSION_ID;
const aos = (root, args) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input: '', env });
const order = (id) => ['---', `id: ${id}`, `title: Title of ${id}`, 'kind: fix', 'created: 2026-11-14', 'budget_max_minutes: 30', 'budget_max_attempts: 2', 'risk: low', 'cost_effect: none', '---', '', '## Acceptance criteria', '', '- [ ] x', ''].join('\n');
const PRE = [{ name: 'the tool is present', run: 'test -f tool.txt', expect_exit: 0 }, { name: 'the baseline holds', run: 'exit 0', expect_exit: 0 }];
const verifyFile = (id, preflight) => `${JSON.stringify({ order: id, ...(preflight ? { preflight } : {}), checks: [{ name: 'the check', run: 'exit 0', expect_exit: 0 }] }, null, 2)}\n`;

function project() {
  const root = mkdtempSync(join(tmpdir(), 'aos-pre-'));
  const a = join(root, '.analucia');
  for (const d of ['orders', 'verify', 'drafts', 'evidence']) mkdirSync(join(a, d), { recursive: true });
  writeFileSync(join(a, 'project.json'), '{"wip_limit":2,"locale":"en"}\n');
  writeFileSync(logPath(root), '');
  writeFileSync(join(a, 'evidence', 'report.md'), '# r\n\n## Evidencia\n\nx\n\nOUTCOME: done\n');
  return root;
}
// A locked order file and verify file, not admitted yet.
function locked(root, id, preflight) {
  writeFileSync(join(root, '.analucia', 'orders', `${id}.md`), order(id));
  writeFileSync(join(root, '.analucia', 'verify', `${id}.json`), verifyFile(id, preflight));
  const lockPath = join(root, '.analucia', 'director.lock');
  const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : { files: {} };
  for (const rel of [`.analucia/orders/${id}.md`, `.analucia/verify/${id}.json`]) lock.files[rel] = hashLF(readFileSync(join(root, rel)));
  writeFileSync(lockPath, JSON.stringify(lock));
}
const log = (root) => readFileSync(logPath(root), 'utf8');
const stateOf = (root, id) => replay(readLog(root).events).orders[id]?.state;
const preflightFiles = (root, id) => (existsSync(join(root, '.analucia', 'evidence', id)) ? readdirSync(join(root, '.analucia', 'evidence', id)).filter((f) => /^preflight-\d+\.txt$/.test(f)) : []);

test('a verify file may carry preflight, with the shape of checks; without it the file is valid as before', () => {
  assert.deepEqual(validateVerifyText(verifyFile('ORD-0001', PRE), 'ORD-0001.json'), []);
  assert.deepEqual(validateVerifyText(verifyFile('ORD-0001'), 'ORD-0001.json'), []);
  const codes = (preflight) => validateVerifyText(verifyFile('ORD-0001', preflight), 'ORD-0001.json').map((e) => e.code);
  assert.deepEqual(codes([{ name: 'no run', expect_exit: 0 }]), ['E_MISSING_FIELD']);
  assert.deepEqual(codes([{ name: 'x', run: 'exit 0', expect_exit: 0, extra: 1 }]), ['E_UNKNOWN_KEY']);
  assert.deepEqual(codes('exit 0'), ['E_FIELD_TYPE']);
  assert.deepEqual(codes([]), ['E_FIELD_TYPE']);
});

test('aos preflight: runs the checks, prints each result and one final line, writes under the evidence folder, changes no state', () => {
  const root = project();
  locked(root, 'ORD-0001', PRE);
  // The prerequisite is missing: exit 1, the failing check is named, the error has its next line.
  const bad = aos(root, ['preflight', 'ORD-0001']);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /^FAIL the tool is present \(exit 1, expected 0\)$/m);
  assert.match(bad.stdout, /^PASS the baseline holds \(exit 0\)$/m);
  assert.match(bad.stderr, /E_PREFLIGHT_FAILED .*1 of 2 preflight check\(s\) failed: the tool is present/);
  assert.match(bad.stderr, /next \(director\)/);
  // Present: exit 0 and one closing line.
  writeFileSync(join(root, 'tool.txt'), 'x\n');
  const ok = aos(root, ['preflight', 'ORD-0001']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout.trimEnd().split('\n').at(-1), 'OK: 2 of 2 preflight check(s) of ORD-0001 passed; evidence .analucia/evidence/ORD-0001/preflight-02.txt');
  assert.deepEqual(preflightFiles(root, 'ORD-0001').sort(), ['preflight-01.txt', 'preflight-02.txt']);
  assert.match(readFileSync(join(root, '.analucia', 'evidence', 'ORD-0001', 'preflight-02.txt'), 'utf8'), /\$ test -f tool\.txt\nexit 0 \(expected 0\): PASS/);
  assert.equal(log(root), '', 'no event: the log is as it was');
  assert.equal(stateOf(root, 'ORD-0001'), undefined);
  // No preflight in the verify file: one line, exit 0. No verify file at all: an error.
  locked(root, 'ORD-0002');
  const none = aos(root, ['preflight', 'ORD-0002']);
  assert.equal(none.status, 0);
  assert.equal(none.stdout, 'OK: ORD-0002 has no preflight in its verify file; nothing to run\n');
  assert.equal(aos(root, ['preflight', 'ORD-0009']).status, 1);
  assert.match(aos(root, ['preflight', 'ORD-0009']).stderr, /E_FILE_MISSING/);
  assert.equal(aos(root, ['preflight']).status, 2, 'usage');
});

test('aos preflight works for a draft, before the owner is asked to place anything', async () => {
  const root = project();
  writeFileSync(join(root, '.analucia', 'drafts', 'ORD-0001.md'), order('ORD-0001'));
  writeFileSync(join(root, '.analucia', 'drafts', 'ORD-0001.json'), verifyFile('ORD-0001', PRE));
  assert.equal(listDrafts(root)[0].ok, true);
  const bad = aos(root, ['preflight', 'ORD-0001']);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /^FAIL the tool is present/m);
  // The owner's PLACE does not place a draft whose preflight fails; the reason is shown and the draft stays.
  const lines = [];
  const r = await sign(root, { isTTY: true, push: false, out: (s) => lines.push(s), ask: async () => 'PLACE' });
  assert.deepEqual(r.placed, []);
  assert.match(lines.join('\n'), /ORD-0001 was not placed: E_PREFLIGHT_FAILED .*the tool is present/);
  assert.ok(existsSync(join(root, '.analucia', 'drafts', 'ORD-0001.md')));
  assert.equal(existsSync(join(root, '.analucia', 'orders', 'ORD-0001.md')), false);
  assert.equal(log(root), '');
  // With the prerequisite in place it is placed.
  writeFileSync(join(root, 'tool.txt'), 'x\n');
  assert.equal(aos(root, ['preflight', 'ORD-0001']).status, 0);
  assert.deepEqual((await sign(root, { isTTY: true, push: false, out: () => {}, ask: async () => 'PLACE' })).placed, ['ORD-0001']);
  assert.equal(stateOf(root, 'ORD-0001'), 'queued');
});

test('aos admit runs the preflight and refuses when a check fails; without preflight it admits as before and says so', () => {
  const root = project();
  locked(root, 'ORD-0001', PRE);
  const refused = aos(root, ['admit', 'ORD-0001']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /aos admit: E_PREFLIGHT_FAILED .*the tool is present/);
  assert.match(refused.stderr, /next \(director\)/);
  assert.equal(log(root), '', 'nothing recorded');
  writeFileSync(join(root, 'tool.txt'), 'x\n');
  const ok = aos(root, ['admit', 'ORD-0001']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /preflight: 2 of 2 check\(s\) passed/);
  assert.equal(stateOf(root, 'ORD-0001'), 'queued');
  locked(root, 'ORD-0002');
  const plain = aos(root, ['admit', 'ORD-0002']);
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /ORD-0002 has no preflight in its verify file/);
  assert.equal(stateOf(root, 'ORD-0002'), 'queued');
});

test('aos run start runs it again: a failing check starts nothing and consumes no attempt', () => {
  const root = project();
  locked(root, 'ORD-0001', PRE);
  writeFileSync(join(root, 'tool.txt'), 'x\n');
  assert.equal(aos(root, ['admit', 'ORD-0001']).status, 0);
  const admitted = log(root);
  // The prerequisite disappears after the admission.
  rmSync(join(root, 'tool.txt'));
  for (let i = 0; i < 3; i++) {
    const r = aos(root, ['run', 'start', 'ORD-0001']);
    assert.equal(r.status, 1, `try ${i + 1}`);
    assert.match(r.stderr, /aos run start: E_PREFLIGHT_FAILED .*the tool is present/);
  }
  assert.equal(log(root), admitted, 'no run.started, no state change, nothing written: three failed starts cost no attempt');
  assert.equal(stateOf(root, 'ORD-0001'), 'queued');
  // Fixed: the first real start is run 1 of 2.
  writeFileSync(join(root, 'tool.txt'), 'x\n');
  const started = aos(root, ['run', 'start', 'ORD-0001']);
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stdout, /run 1 of 2 started/);
  assert.equal(stateOf(root, 'ORD-0001'), 'active');
  // An order without preflight starts as before.
  locked(root, 'ORD-0002');
  assert.equal(aos(root, ['admit', 'ORD-0002']).status, 0);
  assert.equal(aos(root, ['run', 'start', 'ORD-0002']).status, 0);
});

test('the director entrypoint says: write the preflight with the order and run it before asking the owner to place anything', () => {
  const entry = readFileSync(fileURLToPath(new URL('../templates/director-entry.md', import.meta.url)), 'utf8');
  const line = entry.split('\n').find((l) => /"preflight"|`preflight`/.test(l) && /aos\.mjs preflight/.test(l));
  assert.ok(line, 'one step with the key and the command');
  assert.match(line, /before/i);
});
