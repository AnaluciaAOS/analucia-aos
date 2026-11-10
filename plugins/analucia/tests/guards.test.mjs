// SPEC-0002 §4: each guard driven like Claude Code drives it (hook JSON on stdin, exit 2 = block).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BEGIN, END, blockTemplate, halt, resume } from '../lib/guards.mjs';
import { appendEvent, logPath, readLog } from '../lib/log.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env };
delete env.CLAUDE_PROJECT_DIR;
const aos = (root, args, input = '') => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input, env });
const SUBCOMMAND = { PreToolUse: 'pre-tool-use', SessionStart: 'session-start' };
const hook = (root, name, payload) => aos(root, ['hook', SUBCOMMAND[name]], JSON.stringify({ session_id: 'sess-1', cwd: root, hook_event_name: name, ...payload }));

function project() {
  const root = mkdtempSync(join(tmpdir(), 'aos-guard-'));
  for (const d of ['orders', 'amendments', 'verify', 'evidence']) mkdirSync(join(root, '.analucia', d), { recursive: true });
  mkdirSync(join(root, 'core'));
  writeFileSync(join(root, '.analucia', 'project.json'), `${JSON.stringify({ wip_limit: 1, github_owner: 'example' })}\n`);
  writeFileSync(logPath(root), '');
  writeFileSync(join(root, '.analucia', 'evidence', 'report.md'), 'evidence\n');
  return root;
}
const blocked = (r, ...patterns) => {
  assert.equal(r.status, 2, `expected block, got ${r.status}: ${r.stderr}`);
  for (const p of patterns) assert.match(r.stderr, p);
};
const allowed = (r) => assert.equal(r.status, 0, `expected allow, got ${r.status}: ${r.stderr}`);

test('PreToolUse blocks writes and deletes on protected paths, saying who can change them', () => {
  const root = project();
  const cases = [
    ['Write', { file_path: '.analucia/orders/ORD-0001.md', content: 'x' }],
    ['Write', { file_path: join(root, '.analucia', 'orders', 'ORD-0001.md'), content: 'x' }],
    ['Edit', { file_path: join(root, 'core', 'NOMENCLATURE.md'), old_string: 'a', new_string: 'b' }],
    ['MultiEdit', { file_path: '.analucia/amendments/AMD-0001.md', edits: [] }],
    ['Write', { file_path: '.analucia/verify/ORD-0001.json', content: '{}' }],
    ['Write', { file_path: '.analucia/director.lock', content: '{}' }],
    ['Write', { file_path: '.analucia/HALT', content: '' }],
    ['Write', { file_path: '.analucia/asks/ASK-0001.md', content: 'x' }], // SPEC-0004 §1: asks are director files
    ['NotebookEdit', { notebook_path: 'core/NOTES.md', new_source: 'x' }],
    ['Bash', { command: 'rm .analucia/verify/ORD-0001.json' }],
    ['Bash', { command: 'echo x > core/SPEC-0002-VERIFY-AND-GUARDS.md' }],
    ['Bash', { command: "sed -i 's/a/b/' .analucia/orders/ORD-0001.md" }],
    ['Bash', { command: 'git checkout -- .analucia/director.lock' }],
    ['Bash', { command: 'rm -f .analucia/HALT' }],
    ['Bash', { command: "node -e \"require('fs').writeFileSync('.analucia/orders/ORD-0002.md','x')\"" }],
    ['PowerShell', { command: 'Set-Content -Path .analucia\\orders\\ORD-0001.md -Value x' }],
    ['PowerShell', { command: 'Remove-Item core\\NOMENCLATURE.md' }],
  ];
  for (const [tool, input] of cases) {
    blocked(hook(root, 'PreToolUse', { tool_name: tool, tool_input: input }), /Analucia: blocked/, /protected path/, /director/, /aos run finish <ORD> --outcome needs_decision/);
  }
});

test('PreToolUse allows reads of protected paths and writes elsewhere', () => {
  const root = project();
  const cases = [
    ['Read', { file_path: '.analucia/orders/ORD-0001.md' }],
    ['Grep', { pattern: 'x', path: '.analucia/orders' }],
    ['Write', { file_path: 'plugins/analucia/core/ORDER_FORMAT.md', content: 'x' }],
    ['Write', { file_path: 'src/core/app.md', content: 'x' }],
    ['Edit', { file_path: '.analucia/evidence/ORD-0001/report.md', old_string: 'a', new_string: 'b' }],
    ['Write', { file_path: '.analucia/events.jsonl', content: '' }], // not a director file (append-only is enforced by aos)
    ['Bash', { command: 'cat .analucia/orders/ORD-0001.md' }],
    ['Bash', { command: 'cat core/NOMENCLATURE.md 2>&1 | head -5' }],
    ['Bash', { command: 'sha256sum .analucia/orders/*.md 2>/dev/null' }],
    ['Bash', { command: 'git add .analucia/orders/ORD-0001.md core/NOMENCLATURE.md' }],
    ['Bash', { command: 'echo hi > notes.txt' }],
    ['Bash', { command: 'node plugins/analucia/bin/aos.mjs verify ORD-0001' }],
    ['PowerShell', { command: 'Get-Content .analucia\\orders\\ORD-0001.md' }],
  ];
  for (const [tool, input] of cases) allowed(hook(root, 'PreToolUse', { tool_name: tool, tool_input: input }));
});

test('HALT: every tool except reads is blocked until the owner resumes', () => {
  const root = project();
  halt(root, { reason: 'owner review', isTTY: true });
  assert.ok(existsSync(join(root, '.analucia', 'HALT')));
  for (const [tool, input] of [['Write', { file_path: 'src/a.js' }], ['Bash', { command: 'ls' }], ['Edit', { file_path: 'README.md' }], ['WebFetch', { url: 'https://example.com' }]]) {
    blocked(hook(root, 'PreToolUse', { tool_name: tool, tool_input: input }), /halted by the owner since .*: owner review/, /owner lifts the halt by running "aos resume" in their own terminal/);
  }
  for (const tool of ['Read', 'Glob', 'Grep', 'LS']) allowed(hook(root, 'PreToolUse', { tool_name: tool, tool_input: { file_path: 'README.md', pattern: '*' } }));
  resume(root, { isTTY: true });
  allowed(hook(root, 'PreToolUse', { tool_name: 'Write', tool_input: { file_path: 'src/a.js' } }));
  const ops = readLog(root).events.filter((e) => e.type === 'operation.logged').map((e) => [e.actor, e.payload.operation]);
  assert.deepEqual(ops, [['owner', 'halt'], ['owner', 'resume']]);
});

test('halt and resume refuse without a TTY (E_OWNER_TTY) and change nothing', () => {
  const root = project();
  const r = aos(root, ['halt', '--reason', 'agent tries'], 'yes\n');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /E_OWNER_TTY/);
  assert.equal(existsSync(join(root, '.analucia', 'HALT')), false);
  halt(root, { reason: 'owner', isTTY: true });
  const s = aos(root, ['resume'], 'yes\n');
  assert.equal(s.status, 1);
  assert.match(s.stderr, /E_OWNER_TTY/);
  assert.equal(existsSync(join(root, '.analucia', 'HALT')), true);
  assert.equal(readLog(root).events.length, 1);
});

test('Stop and PreCompact: check-writeback blocks while a run is open or the chain is broken', () => {
  const root = project();
  writeFileSync(join(root, '.analucia', 'orders', 'ORD-0001.md'), '---\nid: ORD-0001\ntitle: t\nkind: build\ncreated: 2026-10-20\nbudget_max_minutes: 30\nbudget_max_attempts: 2\n---\n\n## Acceptance criteria\n\n- [ ] x\n');
  allowed(aos(root, ['check-writeback']));
  appendEvent(root, { type: 'record.created', actor: 'director', subject: 'ORD-0001' });
  appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: 'ORD-0001', payload: { from: 'draft', to: 'ready' } });
  appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: 'ORD-0001', payload: { from: 'ready', to: 'queued' } });
  assert.equal(aos(root, ['run', 'start', 'ORD-0001']).status, 0);
  // ORD-0029 B: the command is printed as it exists on this machine, not as "aos run finish".
  blocked(aos(root, ['check-writeback'], '{"hook_event_name":"Stop","stop_hook_active":false}'), /run 1 of ORD-0001 is still open/, /node "[^"]+\/bin\/aos\.mjs" run finish ORD-0001 --outcome/);
  blocked(aos(root, ['check-writeback'], '{"hook_event_name":"PreCompact"}'), /still open/);
  assert.equal(aos(root, ['run', 'finish', 'ORD-0001', '--outcome', 'done', '--evidence', '.analucia/evidence/report.md']).status, 0);
  allowed(aos(root, ['check-writeback']));
  const buf = readFileSync(logPath(root));
  buf[buf.indexOf('"ready"') + 1] = 'R'.charCodeAt(0); // edit one byte of line 2: the link at line 3 breaks
  writeFileSync(logPath(root), buf);
  blocked(aos(root, ['check-writeback']), /event log is broken at \.analucia\/events\.jsonl line 3/, /director restores it from git/);
});

test('SessionStart: derives, prints resume.md as context, and records role.declared with an agent', () => {
  const root = project();
  const r = hook(root, 'SessionStart', { source: 'startup', model: 'claude-opus-5-5' });
  allowed(r);
  assert.match(r.stdout, /^Status: 0 orders/);
  assert.match(r.stdout, /## Pending signatures/);
  assert.ok(existsSync(join(root, '.analucia', 'views', 'resume.md')));
  // AMD-0007 §2: role.declared, then session.start with the same session.
  const [e, s] = readLog(root).events.slice(-2);
  assert.equal(s.type, 'session.start');
  assert.deepEqual(s.payload, { session: 'sess-1', order: null, provider: 'claude-code', source: 'startup' });
  assert.equal(e.type, 'role.declared');
  assert.equal(e.actor, 'executor');
  assert.deepEqual(e.agent, { tool: 'claude-code', model: 'claude-opus-5-5', session: 'sess-1' });
  assert.equal(aos(root, ['validate']).status, 0);
  halt(root, { reason: 'stop all', isTTY: true });
  assert.match(hook(root, 'SessionStart', {}).stdout, /HALT: halted by the owner since .*: stop all/);
});

const NEXT_BLOCK = '<!-- BEGIN:nextjs-agent-rules -->\n# Next.js rules\n\nUse the App Router. Read node_modules/next/dist/docs before coding.\n<!-- END:nextjs-agent-rules -->\n';

test('agents-md sync keeps a foreign Next.js block, is idempotent, and passes check-roles', () => {
  const root = project();
  writeFileSync(join(root, 'AGENTS.md'), `# Project agents\n\n${NEXT_BLOCK}`);
  assert.equal(aos(root, ['check-roles']).status, 1);
  assert.equal(aos(root, ['agents-md', 'sync']).status, 0);
  const once = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  assert.ok(once.includes(NEXT_BLOCK), 'foreign block preserved byte for byte');
  assert.ok(once.startsWith('# Project agents\n\n'));
  assert.ok(once.includes(`${BEGIN}\n${blockTemplate(root)}${END}`));
  assert.equal(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
  const again = aos(root, ['agents-md', 'sync']);
  assert.match(again.stdout, /AGENTS\.md unchanged/);
  assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), once, 'idempotent');
  const ok = aos(root, ['check-roles']);
  assert.equal(ok.status, 0, ok.stderr);

  // An outdated block is refreshed in place; the foreign block still survives.
  writeFileSync(join(root, 'AGENTS.md'), once.replace('No order file, no work', 'No order file, some work'));
  assert.match(aos(root, ['check-roles']).stderr, /differs from the plugin rules/);
  assert.equal(aos(root, ['agents-md', 'sync']).status, 0);
  assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), once);
});

test('check-roles fails on a duplicated block, a missing import, or director instructions in CLAUDE.md', () => {
  const root = project();
  assert.equal(aos(root, ['agents-md', 'sync']).status, 0);
  const good = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  writeFileSync(join(root, 'AGENTS.md'), `${good}\n${BEGIN}\n${blockTemplate(root)}${END}\n`);
  assert.match(aos(root, ['check-roles']).stderr, /E_ROLES .*duplicated/);
  assert.match(aos(root, ['agents-md', 'sync']).stderr, /E_ROLES/);
  writeFileSync(join(root, 'AGENTS.md'), good);
  writeFileSync(join(root, 'CLAUDE.md'), '# Notes\n');
  assert.match(aos(root, ['check-roles']).stderr, /does not import "@AGENTS\.md"/);
  writeFileSync(join(root, 'CLAUDE.md'), '@AGENTS.md\n\nYou are the director: write orders and admit work.\n');
  assert.match(aos(root, ['check-roles']).stderr, /contains director instructions/);
  writeFileSync(join(root, 'CLAUDE.md'), '@AGENTS.md\n');
  assert.equal(aos(root, ['check-roles']).status, 0);
});

const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

test('check-push refuses a wrong account and passes with example; the pre-push hook enforces it', () => {
  const root = project();
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'remote', 'add', 'origin', 'https://someone-else@github.com/example/demo.git');
  git(root, 'config', 'credential.https://github.com.username', 'example');
  let r = aos(root, ['check-push']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /E_ACCOUNT push refused: remote "origin" URL user is "someone-else"/);
  assert.match(r.stderr, /git remote set-url origin https:\/\/example@github\.com/);

  git(root, 'remote', 'set-url', 'origin', 'https://example@github.com/example/demo.git');
  git(root, 'config', 'credential.https://github.com.username', 'other-account');
  r = aos(root, ['check-push']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /credential\.https:\/\/github\.com\.username is "other-account"/);

  git(root, 'config', 'credential.https://github.com.username', 'example');
  r = aos(root, ['check-push']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(aos(root, ['check-push', 'origin', 'git@github.com:example/demo.git']).status, 1, 'ssh user "git" is not the owner');

  // Installed as pre-push: a push to a remote without the owner's user is refused by git itself.
  assert.equal(aos(root, ['install-git-hooks']).status, 0);
  assert.equal(git(root, 'config', '--local', '--get', 'core.hooksPath').stdout.trim(), '.githooks');
  assert.match(readFileSync(join(root, '.githooks', 'pre-push'), 'utf8'), /check-push "\$1" "\$2"/);
  const bare = mkdtempSync(join(tmpdir(), 'aos-bare-'));
  git(bare, 'init', '-q', '--bare');
  git(root, 'remote', 'add', 'local', bare);
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'x');
  const push = git(root, 'push', '-q', 'local', 'main');
  assert.notEqual(push.status, 0);
  assert.match(push.stderr, /E_ACCOUNT/);
  assert.equal(git(bare, 'rev-parse', '--verify', '-q', 'refs/heads/main').status, 1, 'nothing reached the remote');
});
