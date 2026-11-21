// ORD-0042 part 5 (OBS-156): the push account is fixed for each project. `aos init` and `aos install-git-hooks` write,
// in the repository's own git configuration only, the user of the remote URL and the credential user for the account
// of the project (never the global configuration, never a credential). A remote that belongs to another account
// gets its own entry in `push_accounts` of project.json, and the push guard checks each push against the account of
// its remote. Every preflight includes the built-in check "push account"; a failure names the one command that
// fixes it and consumes no attempt.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { accountOf, fixPushAccounts, pushAccountProblems } from '../lib/guards.mjs';
import { hashLF } from '../lib/lock.mjs';
import { appendEvent, logPath } from '../lib/log.mjs';
import { onboardingStarted, runInit } from '../lib/onboarding.mjs';
import { validateProjectText } from '../lib/validate.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
delete env.CLAUDE_PROJECT_DIR;
delete env.CLAUDE_CODE_SESSION_ID;
const aos = (root, args) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input: '', env });
const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' });
const url = (root, remote = 'origin') => git(root, 'remote', 'get-url', remote).stdout.trim();
const credUser = (root, remoteUrl) => git(root, 'config', '--local', '--get-urlmatch', 'credential.username', remoteUrl).stdout.trim();
const localConfig = (root) => git(root, 'config', '--local', '--list').stdout;
const globalCred = () => spawnSync('git', ['config', '--global', '--get-regexp', '^credential\\..*username$'], { encoding: 'utf8' }).stdout;

function repo(project, remotes = { origin: 'https://github.com/acme/demo.git' }) {
  const root = mkdtempSync(join(tmpdir(), 'aos-acct-'));
  git(root, 'init', '-q', '-b', 'main');
  for (const [name, u] of Object.entries(remotes)) git(root, 'remote', 'add', name, u);
  if (project) {
    mkdirSync(join(root, '.analucia', 'orders'), { recursive: true });
    mkdirSync(join(root, '.analucia', 'verify'), { recursive: true });
    writeFileSync(join(root, '.analucia', 'project.json'), `${JSON.stringify({ wip_limit: 1, locale: 'en', ...project })}\n`);
    writeFileSync(logPath(root), '');
  }
  return root;
}
function placeOrder(root, id = 'ORD-0001') {
  writeFileSync(join(root, '.analucia', 'orders', `${id}.md`), ['---', `id: ${id}`, 'title: T', 'kind: fix', 'created: 2026-11-16', 'budget_max_minutes: 30', 'budget_max_attempts: 2', 'risk: low', 'cost_effect: none', '---', '', '## Acceptance criteria', '', '- [ ] x', ''].join('\n'));
  writeFileSync(join(root, '.analucia', 'verify', `${id}.json`), JSON.stringify({ order: id, checks: [{ name: 'c', run: 'exit 0', expect_exit: 0 }] }));
  const files = {};
  for (const rel of [`.analucia/orders/${id}.md`, `.analucia/verify/${id}.json`]) files[rel] = hashLF(readFileSync(join(root, rel)));
  writeFileSync(join(root, '.analucia', 'director.lock'), JSON.stringify({ files }));
}

test('aos install-git-hooks writes the account in the repository own configuration: remote URL user and credential user', () => {
  const before = globalCred();
  const root = repo({ github_owner: 'acme-owner' });
  assert.deepEqual(pushAccountProblems(root).map((p) => p.remote), ['origin']);
  const r = aos(root, ['install-git-hooks']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(url(root), 'https://acme-owner@github.com/acme/demo.git');
  assert.equal(credUser(root, url(root)), 'acme-owner');
  assert.deepEqual(pushAccountProblems(root), []);
  assert.equal(globalCred(), before, 'the global configuration is not touched');
  assert.doesNotMatch(localConfig(root), /password|helper\s*=\s*store|token/i, 'never a credential');
  // Idempotent, and a URL that named another user is corrected.
  const config = localConfig(root);
  assert.equal(aos(root, ['install-git-hooks']).status, 0);
  assert.equal(localConfig(root), config);
  git(root, 'remote', 'set-url', 'origin', 'https://someone-else@github.com/acme/demo.git');
  assert.deepEqual(fixPushAccounts(root).map((f) => f.remote), ['origin']);
  assert.equal(url(root), 'https://acme-owner@github.com/acme/demo.git');
  // Not touched: a remote that is not an HTTPS GitHub URL, and a project that works without GitHub.
  const ssh = repo({ github_owner: 'acme-owner' }, { origin: 'git@github.com:acme/demo.git' });
  assert.equal(aos(ssh, ['install-git-hooks']).status, 0);
  assert.equal(url(ssh), 'git@github.com:acme/demo.git');
  const none = repo({ github_owner: 'none' });
  assert.equal(aos(none, ['install-git-hooks']).status, 0);
  assert.equal(url(none), 'https://github.com/acme/demo.git');
  assert.deepEqual(pushAccountProblems(none), [], 'no account to check');
});

test('aos init writes it too, after CONFIRM', async () => {
  const root = repo(null);
  await runInit(root, { provided: { purpose: 'x', github_owner: 'acme-owner', owner_locale: 'en' }, locale: 'en', dryRun: true, isTTY: true, ask: async () => 'CONFIRM', out: () => {} });
  assert.equal(url(root), 'https://github.com/acme/demo.git', 'a dry run changes nothing');
  await runInit(root, { provided: { purpose: 'x', github_owner: 'acme-owner', owner_locale: 'en' }, locale: 'en', isTTY: true, ask: async () => 'CONFIRM', out: () => {}, onConfirmed: () => onboardingStarted(root) });
  assert.equal(url(root), 'https://acme-owner@github.com/acme/demo.git');
  assert.equal(credUser(root, url(root)), 'acme-owner');
  assert.deepEqual(pushAccountProblems(root), []);
});

test('push_accounts: a remote of another account has its own entry, and the push guard checks each push against the account of its remote', () => {
  assert.deepEqual(validateProjectText('{"wip_limit":1,"github_owner":"main-acct","push_accounts":{"public":"pub-acct"}}'), []);
  for (const bad of ['{"push_accounts":["pub-acct"]}', '{"push_accounts":{"public":""}}', '{"push_accounts":{"public":7}}', '{"push_accounts":{"bad name!":"x"}}']) {
    assert.deepEqual(validateProjectText(bad).map((e) => e.code), ['E_FIELD_TYPE'], bad);
  }
  const root = repo({ github_owner: 'main-acct', push_accounts: { public: 'pub-acct' } }, { origin: 'https://github.com/acme/private.git', public: 'https://github.com/acme/public.git' });
  assert.equal(accountOf(root, 'origin'), 'main-acct');
  assert.equal(accountOf(root, 'public'), 'pub-acct');
  assert.equal(accountOf(root, 'another'), 'main-acct', 'a remote without an entry belongs to the account of the project');
  assert.deepEqual(pushAccountProblems(root).map((p) => [p.remote, p.account]), [['origin', 'main-acct'], ['public', 'pub-acct']]);
  assert.equal(aos(root, ['install-git-hooks']).status, 0);
  assert.equal(url(root, 'origin'), 'https://main-acct@github.com/acme/private.git');
  assert.equal(url(root, 'public'), 'https://pub-acct@github.com/acme/public.git');
  assert.equal(credUser(root, url(root, 'origin')), 'main-acct');
  assert.equal(credUser(root, url(root, 'public')), 'pub-acct');
  assert.deepEqual(pushAccountProblems(root), []);
  // The guard: each push against the account of its remote.
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'a.js'), 'x\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  const ok = aos(root, ['check-push', 'public', 'https://pub-acct@github.com/acme/public.git']);
  assert.match(ok.stdout + ok.stderr, /check-push: ok \(pub-acct|E_NO_ORDER_TRAILER/, 'the account of the remote "public" is accepted');
  const wrong = aos(root, ['check-push', 'public', 'https://main-acct@github.com/acme/public.git']);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /E_ACCOUNT .*remote "public".*"pub-acct"/);
  const origin = aos(root, ['check-push', 'origin', 'https://pub-acct@github.com/acme/private.git']);
  assert.match(origin.stderr, /E_ACCOUNT .*remote "origin".*"main-acct"/);
});

test('every preflight includes the built-in check "push account": a failure names the one command and consumes no attempt', () => {
  const root = repo({ github_owner: 'acme-owner' });
  placeOrder(root);
  // admit: refused, nothing recorded.
  const refused = aos(root, ['admit', 'ORD-0001']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /E_PREFLIGHT_FAILED .*push account \(origin\)/);
  assert.equal(readFileSync(logPath(root), 'utf8'), '');
  // aos preflight: the failing check, and the one command that fixes it.
  const pre = aos(root, ['preflight', 'ORD-0001']);
  assert.equal(pre.status, 1);
  assert.match(pre.stdout, /^FAIL push account \(origin\)/m);
  assert.match(pre.stdout, /fix it with: node ".*aos\.mjs" install-git-hooks/);
  // The command, then everything passes; the verify file has no preflight of its own and the built-in check still runs.
  assert.equal(aos(root, ['install-git-hooks']).status, 0);
  const ok = aos(root, ['preflight', 'ORD-0001']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^PASS push account \(origin\)/m);
  assert.match(ok.stdout, /^PASS push guard installed/m); // ORD-0043 part 12: the second built-in check
  assert.match(ok.stdout.trimEnd().split('\n').at(-1), /^OK: 2 of 2 preflight check\(s\) of ORD-0001 passed/);
  assert.equal(aos(root, ['admit', 'ORD-0001']).status, 0);
  // run start: the account is broken again; nothing starts and no attempt is consumed.
  git(root, 'remote', 'set-url', 'origin', 'https://someone-else@github.com/acme/demo.git');
  const before = readFileSync(logPath(root), 'utf8');
  const start = aos(root, ['run', 'start', 'ORD-0001']);
  assert.equal(start.status, 1);
  assert.match(start.stderr, /E_PREFLIGHT_FAILED .*push account \(origin\)/);
  assert.equal(readFileSync(logPath(root), 'utf8'), before);
  assert.equal(aos(root, ['install-git-hooks']).status, 0);
  assert.match(aos(root, ['run', 'start', 'ORD-0001']).stdout, /run 1 of 2 started/);
});

test('a project without an account, or without a remote, has no such check', () => {
  const noAccount = repo({});
  placeOrder(noAccount);
  const a = aos(noAccount, ['preflight', 'ORD-0001']);
  assert.equal(a.stdout, 'OK: ORD-0001 has no preflight in its verify file; nothing to run\n');
  const noRemote = repo({ github_owner: 'acme-owner' }, {});
  placeOrder(noRemote);
  assert.equal(aos(noRemote, ['preflight', 'ORD-0001']).stdout, 'OK: ORD-0001 has no preflight in its verify file; nothing to run\n');
  assert.equal(aos(noRemote, ['admit', 'ORD-0001']).status, 0);
  appendEvent(noRemote, { type: 'operation.logged', actor: 'owner', subject: null, payload: { operation: 'x' } });
});
