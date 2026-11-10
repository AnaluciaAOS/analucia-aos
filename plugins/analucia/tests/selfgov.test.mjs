// SPEC-0004 §3–§6: order trailer guard, secret guard, credential in URL, permission profile, director scope.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { appendEvent, logPath, readLog } from '../lib/log.mjs';
import { PROFILE, permissionsWrite } from '../lib/permissions.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env };
delete env.CLAUDE_PROJECT_DIR;
const aos = (root, args) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input: '', env });
const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' });
const GOOD_URL = 'https://example@github.com/example/demo.git';
const push = (root, url = GOOD_URL) => aos(root, ['check-push', 'origin', url]);

// A repo whose origin (a local bare repo) already has the first commit; ORD-0001 has a run.started, ORD-0002 does not.
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'aos-push-'));
  const bare = mkdtempSync(join(tmpdir(), 'aos-bare-'));
  git(bare, 'init', '-q', '--bare');
  git(root, 'init', '-q', '-b', 'main');
  mkdirSync(join(root, '.analucia'), { recursive: true });
  mkdirSync(join(root, 'plugins'), { recursive: true });
  writeFileSync(join(root, '.analucia', 'project.json'), '{"wip_limit":1,"github_owner":"example"}\n');
  writeFileSync(logPath(root), '');
  appendEvent(root, { type: 'record.created', actor: 'director', subject: 'ORD-0001' });
  appendEvent(root, { type: 'record.created', actor: 'director', subject: 'ORD-0002' });
  appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: 'ORD-0001', payload: { from: 'draft', to: 'ready' } });
  appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: 'ORD-0001', payload: { from: 'ready', to: 'queued' } });
  appendEvent(root, { type: 'order.state_changed', actor: 'executor', subject: 'ORD-0001', payload: { from: 'queued', to: 'active' } });
  appendEvent(root, { type: 'run.started', actor: 'executor', subject: 'ORD-0001', payload: { run: 1 } });
  writeFileSync(join(root, 'plugins', 'tool.mjs'), 'export const x = 1;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  git(root, 'remote', 'add', 'origin', bare);
  git(root, 'push', '-q', '--no-verify', 'origin', 'main');
  git(root, 'fetch', '-q', 'origin');
  git(root, 'config', 'credential.https://github.com.username', 'example');
  return root;
}
const commit = (root, files, message) => {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  git(root, 'add', '-A');
  assert.equal(git(root, 'commit', '-q', '-m', message).status, 0);
};
const refused = (r, code) => {
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, new RegExp(`aos check-push: ${code} [^\\n]*\\n {2}next \\(`));
};

test('a commit touching plugins/** without a trailer is refused; with a valid trailer it passes', () => {
  const root = repo();
  commit(root, { 'plugins/tool.mjs': 'export const x = 2;\n' }, 'change the tool');
  const r = push(root);
  refused(r, 'E_NO_ORDER_TRAILER');
  assert.match(r.stderr, /- [0-9a-f]{7} changes plugins\/tool\.mjs but has no "Analucia-Order: ORD-NNNN" trailer/);
  git(root, 'commit', '-q', '--amend', '-m', 'change the tool\n\nAnalucia-Order: ORD-0001');
  const ok = push(root);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /1 commit\(s\) in origin\/main\.\.HEAD/);
});

test('a commit touching only owner and director paths passes without a trailer', () => {
  const root = repo();
  appendEvent(root, { type: 'operation.logged', actor: 'owner', subject: null, payload: { operation: 'note' } });
  commit(root, { '.analucia/evidence/ORD-0001/report.md': 'evidence\n', 'core/SPEC-0009-X.md': '# spec\n', '.analucia/asks/ASK-0001.md': 'q\n' }, 'Owner sign-off and director files');
  const r = push(root);
  assert.equal(r.status, 0, r.stderr);
  commit(root, { 'core/sub/NOT-A-SPEC.md': 'x\n' }, 'nested core file is not a director path');
  refused(push(root), 'E_NO_ORDER_TRAILER');
});

test('a trailer naming an order that never started is refused', () => {
  const root = repo();
  commit(root, { 'plugins/tool.mjs': 'export const x = 3;\n' }, 'work\n\nAnalucia-Order: ORD-0002');
  const r = push(root);
  refused(r, 'E_NO_ORDER_TRAILER');
  assert.match(r.stderr, /names ORD-0002 in its trailer, but no such order has a run\.started/);
  git(root, 'commit', '-q', '--amend', '-m', 'work\n\nAnalucia-Order: ORD-0099');
  refused(push(root), 'E_NO_ORDER_TRAILER');
});

test('a fake token built at run time is refused, and the message hides it', () => {
  const root = repo();
  // Built at run time so no token-shaped literal is ever committed (SPEC-0004 §5).
  const fakes = {
    github_token: ['gh', 'p_', 'A1b2C3d4'.repeat(5)].join(''),
    anthropic_api_key: ['sk', '-ant-', 'api03-', 'x9Y8z7W6'.repeat(4)].join(''),
    aws_access_key_id: ['AK', 'IA', 'Q2W3E4R5T6Y7U8I9'].join(''),
    private_key_block: ['-----BEGIN ', 'RSA ', 'PRIVATE KEY-----'].join(''),
    resend_api_key: ['re', '_', 'Ab12Cd34', '_', 'Ef56Gh78Ij90Kl12Mn34Op56'].join(''),
  };
  for (const [name, value] of Object.entries(fakes)) {
    const r0 = repo();
    commit(r0, { 'plugins/config.mjs': `// config\nexport const key = "${value}";\n` }, `add config\n\nAnalucia-Order: ORD-0001`);
    const r = push(r0);
    refused(r, 'E_SECRET');
    assert.match(r.stderr, new RegExp(`- [0-9a-f]{7} plugins/config\\.mjs:2 matches ${name}`), name);
    assert.ok(!(r.stdout + r.stderr).includes(value), `${name}: the value must never be printed`);
  }
  // Secrets are refused even in owner/director paths (evidence reports carry raw outputs).
  commit(root, { '.analucia/evidence/ORD-0001/out.txt': `token ${fakes.github_token}\n` }, 'evidence');
  refused(push(root), 'E_SECRET');
});

test('a credential in the remote URL is refused, and the message hides it', () => {
  const root = repo();
  const secret = ['p4ss', 'w0rd', '-', 'x'.repeat(8)].join('');
  const r = push(root, `https://example:${secret}@github.com/example/demo.git`);
  refused(r, 'E_SECRET_IN_URL');
  assert.match(r.stderr, /https:\/\/example:\*\*\*@github\.com/);
  assert.ok(!(r.stdout + r.stderr).includes(secret));
});

test('aos role declare director --scope records the scope; the director must declare one', () => {
  const root = repo();
  const r = aos(root, ['role', 'declare', 'director', '--scope', '.analucia/orders, core, ../analucia-lab']);
  assert.equal(r.status, 0, r.stderr);
  const e = readLog(root).events.at(-1);
  assert.deepEqual([e.type, e.actor, e.payload], ['role.declared', 'director', { role: 'director', scope: ['.analucia/orders', 'core', '../analucia-lab'] }]);
  const noScope = aos(root, ['role', 'declare', 'director']);
  assert.equal(noScope.status, 1);
  assert.match(noScope.stderr, /E_MISSING_FIELD/);
  assert.match(aos(root, ['role', 'declare', 'boss', '--scope', 'x']).stderr, /E_ACTOR_ENUM/);
  assert.equal(aos(root, ['validate']).status, 0);
});

test('the permission profile: git push under ask, force push under deny, foreign keys kept, local settings untouched', () => {
  const root = mkdtempSync(join(tmpdir(), 'aos-perm-'));
  mkdirSync(join(root, '.claude'));
  const local = '{"permissions":{"allow":["Bash(anything *)"]}}\n';
  writeFileSync(join(root, '.claude', 'settings.local.json'), local);
  writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ model: 'keep-me', permissions: { allow: ['Bash(make *)', 'Bash(git push *)'], defaultMode: 'default' }, enabledPlugins: { 'other@elsewhere': true } }));
  const mp = { name: 'analucia-aos', plugin: 'analucia', repo: 'example/analucia-aos' };
  const first = permissionsWrite(root, { marketplace: mp });
  assert.equal(first.changed, true);
  const s = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'));
  assert.ok(s.permissions.ask.some((r) => /git push/.test(r)));
  assert.ok(s.permissions.deny.some((r) => /push --force/.test(r)) && s.permissions.deny.some((r) => /push -f/.test(r)));
  for (const r of ['Bash(git reset --hard *)', 'Bash(rm -rf *)', 'Read(**/.env)', 'Read(**/.env.*)', 'Read(**/*.pem)', 'Read(**/*.key)']) assert.ok(s.permissions.deny.includes(r), r);
  for (const r of ['Bash(node *)', 'Bash(git commit *)', 'Edit(/**)']) assert.ok(s.permissions.allow.includes(r), r);
  assert.ok(!s.permissions.allow.includes('Bash(git push *)'), 'a push is never silently allowed');
  assert.ok(s.permissions.allow.includes('Bash(make *)'), 'foreign rules kept');
  assert.equal(s.permissions.defaultMode, 'default');
  assert.equal(s.model, 'keep-me');
  assert.deepEqual(s.enabledPlugins, { 'other@elsewhere': true, 'analucia@analucia-aos': true });
  assert.deepEqual(s.extraKnownMarketplaces, { 'analucia-aos': { source: { source: 'github', repo: 'example/analucia-aos' } } });
  assert.equal(readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8'), local);
  assert.equal(permissionsWrite(root, { marketplace: mp }).changed, false, 'idempotent');
  assert.deepEqual(PROFILE.ask, ['Bash(git push *)']);
});

// ORD-0033 C.2: a public checkout built from the release manifest is a plain folder (no git init), so git cannot
// say what is ignored there: the test skips and names the missing path; in a git checkout it runs as before.
const selfRoot = fileURLToPath(new URL('../../..', import.meta.url));
const gitSkip = existsSync(join(selfRoot, '.git')) ? false : 'not in this checkout: .git (a public checkout copied from the release manifest, without git)';

test('this repo: .claude/settings.json is committed-able and settings.local.json stays ignored', { skip: gitSkip }, () => {
  const repoRoot = selfRoot;
  assert.equal(spawnSync('git', ['-C', repoRoot, 'check-ignore', '-q', '.claude/settings.local.json']).status, 0);
  assert.equal(spawnSync('git', ['-C', repoRoot, 'check-ignore', '-q', '.claude/settings.json']).status, 1);
  const s = JSON.parse(readFileSync(join(repoRoot, '.claude', 'settings.json'), 'utf8'));
  assert.equal(s.enabledPlugins['analucia@analucia-aos'], true);
});
