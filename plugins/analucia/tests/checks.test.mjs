// SPEC-0005 §5: setup checks, inventory and report. No test touches the network.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { reportText, runChecks } from '../lib/checks.mjs';
import { MARKETPLACE } from '../lib/cli.mjs';
import { appendEvent, logPath, readLog } from '../lib/log.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env };
delete env.CLAUDE_PROJECT_DIR;
const aos = (root, args) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input: '', env });
const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' });
const URL_HTTPS = 'https://example@github.com/example/demo.git';
const reachable = () => ({ ok: true, ms: 5 });
// What this machine's Claude Code knows about the plugin is injected, so no test reads the real home folder.
const noInstall = { entries: [], marketplaceKnown: false };

// A repo bound to example with one commit; `startup` adds a role.declared from a session with the hooks.
function repo({ url = URL_HTTPS, cred = 'example', startup = true, files = {}, locale = 'en' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aos-check-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'remote', 'add', 'origin', url);
  git(root, 'config', 'credential.https://github.com.username', cred);
  mkdirSync(join(root, '.analucia', 'orders'), { recursive: true });
  writeFileSync(join(root, '.analucia', 'project.json'), `${JSON.stringify({ wip_limit: 1, github_owner: 'example', locale })}\n`);
  writeFileSync(logPath(root), '');
  if (startup) appendEvent(root, { type: 'role.declared', actor: 'executor', subject: null, agent: { tool: 'claude-code' }, payload: { role: 'executor', source: 'startup' } });
  writeFileSync(join(root, 'README.md'), '# demo\n');
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  return root;
}
const byName = (results) => Object.fromEntries(results.map((r) => [r.name, r]));

test('a healthy repo: only branch_protection warns (cloud_access is not asked), and every WARN/FAIL has a next line', () => {
  const root = repo();
  const { results, failed } = runChecks(root, { lsRemote: reachable });
  const r = byName(results);
  assert.equal(failed, false);
  assert.deepEqual(results.filter((x) => x.status !== 'PASS').map((x) => x.name).filter((n) => n !== 'tools'), ['branch_protection']);
  assert.equal(r.cloud_access, undefined);
  for (const x of results) if (x.status !== 'PASS') assert.ok(x.next?.who && x.next?.key, `${x.name} has a next line`);
  assert.match(reportText(results), /WARN branch_protection: [^\n]*\n {2}next \(owner\): If your plan allows it, turn on branch protection/);
});

test('an SSH remote gives WARN remote_https, with the HTTPS command', () => {
  const root = repo({ url: 'git@github.com:example/demo.git' });
  const r = byName(runChecks(root, { lsRemote: reachable }).results);
  assert.equal(r.remote_https.status, 'WARN');
  assert.match(reportText(Object.values(r)), /remote_https: origin does not use HTTPS \(git@github\.com:example\/demo\.git\)\n {2}next \(owner\): Run in this folder \(SSH needs keys that most owners do not have\):\n {6}git remote set-url origin https:\/\/example@github\.com\/example\/demo\.git\n/);
});

test('a credential username different from github_owner gives FAIL account, with the one command that binds it', () => {
  const root = repo({ cred: 'someone-else' });
  const { results, failed } = runChecks(root, { lsRemote: reachable });
  const r = byName(results);
  assert.equal(failed, true);
  assert.equal(r.account.status, 'FAIL');
  const text = reportText(results);
  assert.match(text, /FAIL account: remote user example, credential user someone-else, github_owner example/);
  assert.match(text, /next \(owner\): Run in this folder:\n {6}git config credential\.https:\/\/github\.com\.username example\n(?! {6})/);
});

test('a tracked fake secret built at run time gives FAIL secrets_tracked, and the value is never printed', () => {
  const token = ['gh', 'p_', 'Q7w8E9r0'.repeat(5)].join('');
  const root = repo({ files: { 'src/config.js': `// settings\nexport const t = "${token}";\n` } });
  const { results } = runChecks(root, { lsRemote: reachable });
  const r = byName(results);
  assert.equal(r.secrets_tracked.status, 'FAIL');
  const text = reportText(results);
  assert.match(text, /src\/config\.js:2 \(github_token\)/);
  assert.match(text, /Rotate the credential first, through a high-risk order/);
  assert.ok(!text.includes(token) && !JSON.stringify(results).includes(token));
  assert.ok(!readFileSync(logPath(root), 'utf8').includes(token), 'not in the inventory event either');
});

test('a .env that is not ignored gives FAIL; an ignored one passes; a tracked one fails even if listed in .gitignore', () => {
  const exposed = repo();
  writeFileSync(join(exposed, '.env'), 'KEY=value\n');
  assert.equal(byName(runChecks(exposed, { lsRemote: reachable }).results).env_ignored.status, 'FAIL');
  assert.match(reportText(runChecks(exposed, { lsRemote: reachable }).results), /FAIL env_ignored: not git-ignored: \.env/);
  const ignored = repo({ files: { '.gitignore': '.env\n.env.*\n' } });
  writeFileSync(join(ignored, '.env'), 'KEY=value\n');
  writeFileSync(join(ignored, '.env.local'), 'KEY=value\n');
  const ok = byName(runChecks(ignored, { lsRemote: reachable }).results).env_ignored;
  assert.equal(ok.status, 'PASS');
  assert.equal(ok.detail.vars.count, 2);
  const tracked = repo({ files: { '.env.production': 'KEY=value\n' } });
  writeFileSync(join(tracked, '.gitignore'), '.env.*\n');
  assert.equal(byName(runChecks(tracked, { lsRemote: reachable }).results).env_ignored.status, 'FAIL');
});

test('no role.declared with source startup gives WARN plugin_active, with the HTTPS install commands of the plugin marketplace', () => {
  const root = repo({ startup: false });
  const { results } = runChecks(root, { lsRemote: reachable, install: noInstall });
  assert.equal(byName(results).plugin_active.status, 'WARN');
  const text = reportText(results);
  // OBS-104: the marketplace is the plugin's own (HTTPS, full address), never this project's repository.
  assert.ok(text.includes(`\n      claude plugin marketplace add ${MARKETPLACE.url}\n      claude plugin install analucia@analucia-aos --scope project`), text);
  assert.doesNotMatch(text, /marketplace add [^\n]*demo/);
  // Marketplace already known: only the install line. Installed for this folder: no command, open a session here.
  assert.doesNotMatch(reportText(runChecks(root, { lsRemote: reachable, install: { entries: [], marketplaceKnown: true } }).results), /marketplace add/);
  const here = reportText(runChecks(root, { lsRemote: reachable, install: { entries: [{ scope: 'project', projectPath: root }], marketplaceKnown: true } }).results);
  assert.match(here, /The plugin is installed for this folder. Open a new Claude Code session in exactly this folder/);
  // ORD-0029 A: installed with project scope for another folder (for example the outer folder of a nested copy).
  const elsewhere = reportText(runChecks(root, { lsRemote: reachable, install: { entries: [{ scope: 'project', projectPath: join(root, '..') }], marketplaceKnown: true } }).results);
  // ORD-0033 B.1: a count, never the other folder's path.
  assert.match(elsewhere, /installed for another folder \(1 in all\), not for this one, and Claude Code loads it only there[^\n]*\n {6}claude plugin install analucia@analucia-aos --scope project/);
  assert.ok(!elsewhere.includes(`(${resolve(root, '..').split('\\').join('/')})`), 'the other folder is not printed (this folder, which contains its path, is)');
});

test('the inventory event is appended once per run, as observed, and cloud_access appears only when asked', () => {
  const root = repo();
  runChecks(root, { lsRemote: reachable });
  runChecks(root, { lsRemote: reachable });
  const inv = readLog(root).events.filter((e) => e.payload?.operation === 'inventory');
  assert.equal(inv.length, 2);
  assert.equal(inv[0].actor, 'system');
  assert.equal(inv[0].payload.level, 'observed');
  assert.equal(inv[0].payload.readme, true);
  assert.deepEqual(inv[0].payload.claude_md, { exists: false, imports_agents: false });
  assert.equal(inv[0].payload.commits, 1);
  assert.equal(aos(root, ['validate']).status, 0);
  writeFileSync(join(root, '.analucia', 'onboarding.json'), JSON.stringify({ locale: 'en', answers: { cloud_sessions: { value: 'yes', source: 'owner', at: '2026-10-21T10:00:00-05:00' } } }));
  const r = byName(runChecks(root, { lsRemote: reachable }).results);
  assert.equal(r.cloud_access.status, 'WARN');
  assert.match(reportText(Object.values(r)), /grant access to example\/demo/);
});

test('aos init --check: exit 0 with only WARN, exit 1 with a FAIL; the report follows the project locale and is saved', () => {
  // https remote, rewritten by git to a local bare repo, so ls-remote really runs but stays offline.
  const bare = mkdtempSync(join(tmpdir(), 'aos-bare-'));
  git(bare, 'init', '-q', '--bare');
  const root = repo({ locale: 'es' });
  git(root, 'config', `url.${bare.replace(/\\/g, '/')}.insteadOf`, URL_HTTPS);
  git(root, 'push', '-q', '--no-verify', 'origin', 'main');
  const ok = aos(root, ['init', '--check']);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /^Comprobaciones del arranque/);
  assert.match(ok.stdout, /PASS reachable: git ls-remote origin respondió en \d+ ms/);
  assert.match(ok.stdout, /WARN branch_protection/);
  assert.match(ok.stdout, /Informe guardado en \.analucia\/views\/onboarding\.md\./);
  assert.match(readFileSync(join(root, '.analucia', 'views', 'onboarding.md'), 'utf8'), /^Comprobaciones del arranque/);
  git(root, 'config', 'credential.https://github.com.username', 'other');
  const bad = aos(root, ['init', '--check']);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /FAIL account/);
});
