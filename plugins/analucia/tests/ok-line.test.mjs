// ORD-0041 part 6 (AMD-0015 §9): every command the owner runs ends with exactly one closing line. On success
// `OK: <what is now true>`; on failure the error with its `next` line, as before. Commands whose output is read by a
// program or a hook (check-writeback, hook …, next, check-push) keep their output as it is.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hashLF } from '../lib/lock.mjs';
import { logPath } from '../lib/log.mjs';
import { OK_COMMANDS, okLine } from '../lib/ok-line.mjs';
import { LOCALES, catalog } from '../lib/onboarding.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
delete env.CLAUDE_PROJECT_DIR;
delete env.CLAUDE_CODE_SESSION_ID;
const aos = (root, args, cwd) => spawnSync(process.execPath, [AOS, ...args, ...(cwd ? [] : ['--root', root])], { encoding: 'utf8', input: '', env, ...(cwd ? { cwd } : {}) });
const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' });
const ORDER = (id) => ['---', `id: ${id}`, 'title: T', 'kind: fix', 'created: 2026-11-14', 'budget_max_minutes: 30', 'budget_max_attempts: 2', 'risk: low', 'cost_effect: none', '---', '', '## Acceptance criteria', '', '- [ ] x', ''].join('\n');

function project() {
  const root = mkdtempSync(join(tmpdir(), 'aos-ok-'));
  const a = join(root, '.analucia');
  for (const d of ['orders', 'verify']) mkdirSync(join(a, d), { recursive: true });
  writeFileSync(join(a, 'project.json'), '{"wip_limit":2,"locale":"en","github_owner":"example"}\n');
  writeFileSync(logPath(root), '');
  writeFileSync(join(a, 'orders', 'ORD-0001.md'), ORDER('ORD-0001'));
  writeFileSync(join(a, 'verify', 'ORD-0001.json'), JSON.stringify({ order: 'ORD-0001', preflight: [{ name: 'p', run: 'exit 0', expect_exit: 0 }], checks: [{ name: 'c', run: 'exit 0', expect_exit: 0 }] }));
  const files = {};
  for (const rel of ['.analucia/orders/ORD-0001.md', '.analucia/verify/ORD-0001.json']) files[rel] = hashLF(readFileSync(join(root, rel)));
  writeFileSync(join(a, 'director.lock'), JSON.stringify({ files }));
  git(root, 'init', '-q', '-b', 'main');
  return root;
}
// The last line is the closing line, and it is the only one.
const closing = (r, label) => {
  assert.equal(r.status, 0, `${label}: ${r.stderr}`);
  const lines = r.stdout.trimEnd().split('\n');
  assert.match(lines.at(-1), /^OK: \S/, `${label}: last line: ${lines.at(-1)}`);
  assert.equal(lines.filter((l) => l.startsWith('OK: ')).length, 1, `${label}: exactly one closing line`);
  return lines.at(-1);
};

test('on success, each command of the list ends with exactly one line "OK: <what is now true>"', () => {
  const root = project();
  assert.equal(closing(aos(root, ['validate']), 'validate'), 'OK: the project files are valid (0 errors, 0 warnings)');
  assert.equal(closing(aos(root, ['verify-log']), 'verify-log'), 'OK: the event log is intact (0 lines)');
  assert.match(closing(aos(root, ['preflight', 'ORD-0001']), 'preflight'), /^OK: 1 of 1 preflight check\(s\) of ORD-0001 passed/);
  assert.equal(closing(aos(root, ['admit', 'ORD-0001']), 'admit'), 'OK: ORD-0001 is admitted and queued; an executor can start it');
  assert.equal(closing(aos(root, ['verify-log']), 'verify-log'), 'OK: the event log is intact (3 lines)');
  assert.equal(closing(aos(root, ['derive']), 'derive'), 'OK: the views are up to date in .analucia/views/');
  assert.match(closing(aos(root, ['launchers', 'install']), 'launchers install'), /^OK: the 7 click launchers are in /);
  assert.match(closing(aos(root, ['sign', '--install-launcher']), 'sign --install-launcher'), /^OK: the FIRMAR launcher is in /);
  assert.equal(closing(aos(root, ['permissions', 'write']), 'permissions write'), 'OK: the permission profile is in .claude/settings.json');
  assert.equal(closing(aos(root, ['install-git-hooks']), 'install-git-hooks'), 'OK: the push guard is installed (.githooks/pre-push)');
  assert.match(closing(aos(root, ['ceo', 'export', '--out', join(root, 'sheet.xlsx')]), 'ceo export'), /^OK: the owner sheet is written: .*sheet\.xlsx/);
  // A single file, and a tree with a warning-free result, close the same way.
  assert.match(closing(aos(root, ['validate', join(root, '.analucia', 'orders', 'ORD-0001.md')]), 'validate <file>'), /^OK: /);
});

test('on failure there is no OK line: the error and its next line close the output, as before', () => {
  const root = project();
  writeFileSync(join(root, '.analucia', 'orders', 'ORD-0001.md'), ORDER('ORD-0001').replace('kind: fix', 'kind: nonsense'));
  const v = aos(root, ['validate']);
  assert.equal(v.status, 1);
  assert.doesNotMatch(v.stdout, /^OK: /m);
  assert.match(v.stdout.trimEnd().split('\n').at(-1), /^ {2}next \(director\): /);
  writeFileSync(logPath(root), 'not json\n');
  const l = aos(root, ['verify-log']);
  assert.equal(l.status, 1);
  assert.doesNotMatch(l.stdout, /^OK: /m);
  assert.match(l.stdout, /next \(/);
  // Owner-only commands without a terminal: refused, no OK line.
  for (const args of [['halt', '--reason', 'x'], ['resume'], ['sign'], ['ceo', 'import', 'x.xlsx']]) {
    const r = aos(root, args);
    assert.notEqual(r.status, 0, args.join(' '));
    assert.doesNotMatch(r.stdout + r.stderr, /^OK: /m, args.join(' '));
    assert.match(r.stderr, /next \(owner\)/, args.join(' '));
  }
});

test('commands whose output is read by a program or a hook keep their output: no OK line', () => {
  const root = project();
  const hook = (name, input = {}) => spawnSync(process.execPath, [AOS, ...name], { encoding: 'utf8', cwd: root, env: { ...env, CLAUDE_PROJECT_DIR: root }, input: JSON.stringify({ cwd: root, ...input }) });
  for (const [label, r] of [
    ['check-writeback', hook(['check-writeback'], { session_id: 's1' })],
    ['hook session-start', hook(['hook', 'session-start'], { session_id: 's1', source: 'startup' })],
    ['hook session-name', hook(['hook', 'session-name'], { session_id: 's1', hook_event_name: 'SessionStart' })],
    ['hook pre-tool-use', hook(['hook', 'pre-tool-use'], { tool_name: 'Read', tool_input: { file_path: 'x' } })],
    ['next', aos(root, ['next'])],
    ['check-push', aos(root, ['check-push', 'origin', 'https://someone@github.com/x/y.git'])],
  ]) assert.doesNotMatch(`${r.stdout}${r.stderr}`, /^OK: /m, label);
  assert.equal(aos(root, ['next']).stdout.trimEnd().split('\n').length, 1);
});

test('the closing line of every listed command exists in the five catalogs, and the owner-only ones use it', () => {
  assert.deepEqual([...OK_COMMANDS].sort(), ['admit', 'ceo_export', 'ceo_import', 'ceo_import_none', 'derive', 'git_hooks', 'halt', 'launcher_firmar', 'launchers', 'permissions', 'repair_log', 'resume', 'sign', 'sign_none', 'status', 'status_chain', 'status_metric', 'status_one', 'update', 'validate', 'validate_hidden', 'verify_log'].sort());
  const facts = { removed: 2, have: 1, state: 'queued', id: 'ORD-0001', errors: 0, warnings: 2, lines: 7, dir: '/p', path: 'x', n: 3, signed: 'ORD-0001', placed: 1, reviewed: 0, file: '.githooks/pre-push' };
  for (const l of LOCALES) {
    for (const c of OK_COMMANDS) {
      const line = okLine(catalog(l), c, facts);
      assert.match(line, /^OK: \S/, `${l} ${c}`);
      assert.doesNotMatch(line, /[{}\n]/, `${l} ${c}: ${line}`);
    }
  }
  // halt, resume, ceo import and sign need the owner's terminal: their closing line is checked in the source.
  const bin = readFileSync(AOS, 'utf8');
  for (const c of ['halt', 'resume', 'ceo_import', 'sign']) assert.ok(bin.includes(`sayOk(root, '${c}'`), `the command prints ok.${c}`);
});
