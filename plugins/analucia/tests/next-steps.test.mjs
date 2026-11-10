// ORD-0029 B: every next step the tools print can be pasted on the user's machine as it is. No placeholder such as
// <owner> or <repo>, no "aos <command>" (aos is not on the PATH), no path that exists only in the plugin's own
// repository, and no suggestion to add the project's own repository as a marketplace.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { reportText, runChecks } from '../lib/checks.mjs';
import { PLUGIN_DIR, SUBCOMMANDS, accountFixes, renderCommands } from '../lib/cli.mjs';
import { ERRORS, renderedNext } from '../lib/errors.mjs';
import { checkPush } from '../lib/guards.mjs';
import { logPath } from '../lib/log.mjs';
import { LOCALES, catalog } from '../lib/onboarding.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env };
delete env.CLAUDE_PROJECT_DIR;
const PLACEHOLDER = /<(?:owner|repo|repository|dueño|dono|github_owner|user|account)>/i;
const BARE_AOS = new RegExp(`(?<![\\w/".-])aos (?:${SUBCOMMANDS.join('|')})\\b`);
const REPO_ONLY = /(?<![\w/:.-])plugins\/analucia\//;

// The checks every printed next step must pass. Absolute paths into the plugin must exist on this machine.
function assertHonest(text, label) {
  assert.doesNotMatch(text, PLACEHOLDER, `${label}: placeholder`);
  assert.doesNotMatch(text, BARE_AOS, `${label}: "aos <command>" is not on the PATH`);
  assert.doesNotMatch(text, REPO_ONLY, `${label}: path that exists only in the plugin repository`);
  for (const m of text.matchAll(/node "([^"]+)"/g)) assert.ok(existsSync(m[1]), `${label}: ${m[1]} does not exist`);
  for (const m of text.matchAll(new RegExp(`${PLUGIN_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[\\w./-]+`, 'g'))) {
    assert.ok(existsSync(m[0].replace(/[.,;:]+$/, '')), `${label}: ${m[0]} does not exist`);
  }
}

test('every next line of the error registry, as printed, can be used as it is', () => {
  for (const code of Object.keys(ERRORS)) assertHonest(renderedNext(code), code);
});

test('every error page, as aos explain prints it, can be used as it is', () => {
  for (const f of readdirSync(join(PLUGIN_DIR, 'docs', 'errors'))) {
    const code = f.replace(/\.md$/, '');
    const r = spawnSync(process.execPath, [AOS, 'explain', code], { encoding: 'utf8', env });
    assert.equal(r.status, 0, code);
    assertHonest(r.stdout, `explain ${code}`);
  }
});

test('no source, catalog or error page carries a <owner>/<repo> placeholder', () => {
  const dirs = ['lib', 'i18n', join('docs', 'errors')];
  for (const d of dirs) {
    for (const f of readdirSync(join(PLUGIN_DIR, d))) {
      assert.doesNotMatch(readFileSync(join(PLUGIN_DIR, d, f), 'utf8'), /<(?:owner|repo|repository|dueño|dono)>/, `${d}/${f}`);
    }
  }
});

test('every next string of the setup checks, in every language, has no placeholder and no bare aos command', () => {
  const vars = { cmds: '\n      git status', owner: 'example', repo: 'demo', root: 'C:/work/demo', folders: 'C:/work', url: 'x', fix: 'x', who: 'owner' };
  for (const l of LOCALES) {
    const t = catalog(l);
    const keys = Object.keys(JSON.parse(readFileSync(join(PLUGIN_DIR, 'i18n', `${l}.json`), 'utf8')).strings).filter((k) => /\.next|^session\./.test(k));
    for (const k of keys) assertHonest(renderCommands(t(k, vars)), `${l} ${k}`);
  }
});

const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' });
function folder({ init = true, url, cred, owner = 'example' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aos-next-'));
  if (init) git(root, 'init', '-q', '-b', 'main');
  if (url) git(root, 'remote', 'add', 'origin', url);
  if (cred) git(root, 'config', 'credential.https://github.com.username', cred);
  mkdirSync(join(root, '.analucia', 'orders'), { recursive: true });
  writeFileSync(join(root, '.analucia', 'project.json'), `${JSON.stringify({ wip_limit: 1, locale: 'en', ...(owner ? { github_owner: owner } : {}) })}\n`);
  writeFileSync(logPath(root), '');
  return root;
}
const noInstall = { entries: [], marketplaceKnown: false };
const checks = (root, ls = () => ({ ok: false, ms: 1 })) => runChecks(root, { lsRemote: ls, install: noInstall }).results;
const byName = (results) => Object.fromEntries(results.map((r) => [r.name, r]));

test('setup checks in the cases of the pilot: every next step is a real, complete command', () => {
  const cases = {
    'a copy without git (ZIP download)': folder({ init: false }),
    'git without a remote': folder(),
    'no github_owner and no remote': folder({ owner: null }),
    'SSH remote': folder({ url: 'git@github.com:example/demo.git', cred: 'example' }),
    'stored credential of another account': folder({ url: 'https://example@github.com/example/demo.git', cred: 'other-account' }),
    'remote without a user and no credential user': folder({ url: 'https://github.com/example/demo.git' }),
    'works without GitHub': folder({ owner: 'none' }),
  };
  for (const [label, root] of Object.entries(cases)) {
    const results = checks(root);
    const text = reportText(results);
    assertHonest(text, label);
    for (const r of results) if (r.status !== 'PASS') assert.ok(r.next?.key, `${label}: ${r.name} has a next step`);
    assert.doesNotMatch(text, /marketplace add (?!https:\/\/github\.com\/AnaluciaAOS\/analucia-aos\.git\n)/, `${label}: marketplace`);
  }
});

test('a copy without a remote fails once, says it is normal, and gives the commands with the real account and folder name', () => {
  const root = folder({ init: false });
  const r = byName(checks(root));
  assert.equal(r.repo.status, 'FAIL');
  for (const n of ['account', 'remote_https', 'reachable']) assert.equal(r[n].status, 'WARN', n);
  const text = reportText(Object.values(r));
  const name = root.split(/[\\/]/).at(-1);
  assert.match(text, /This is normal in a copy/);
  assert.ok(text.includes(`\n      git init\n      git remote add origin https://example@github.com/example/${name}.git`), text);
  assert.equal(Object.values(r).filter((x) => x.status === 'FAIL').length, 1, 'one FAIL, not three');
});

test('a stored credential user that differs from github_owner gets exactly the one command that fixes it', () => {
  const root = folder({ url: 'https://example@github.com/example/demo.git', cred: 'other-account' });
  const r = byName(checks(root, () => ({ ok: true, ms: 1 })));
  assert.equal(r.account.status, 'FAIL');
  assert.equal(r.account.next.vars.cmds, '\n      git config credential.https://github.com.username example');
  // When ls-remote fails, the one-line command that reaches GitHub with that account (OBS-097).
  const down = reportText(checks(root));
  assert.ok(down.includes('\n      git -c credential.https://github.com.username=example ls-remote https://example@github.com/example/demo.git'), down);
  assert.deepEqual(accountFixes({ owner: 'example', user: 'example', cred: 'other-account', url: 'https://example@github.com/example/demo.git' }), ['git config credential.https://github.com.username example']);
});

test('in a customer project the AGENTS.md block names the CLI and the docs by paths that exist there (OBS-106)', () => {
  const root = folder();
  assert.equal(spawnSync(process.execPath, [AOS, 'agents-md', 'sync', '--root', root], { encoding: 'utf8', env }).status, 0);
  const text = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  assert.doesNotMatch(text, REPO_ONLY);
  const cli = /CLI: `node "([^"]+)" <command>`/.exec(text);
  assert.ok(cli && existsSync(cli[1]), 'the CLI line names the installed aos.mjs');
  assert.ok(existsSync(/Read `([^`]+INDEX\.md)`/.exec(text)[1]), 'the docs index exists');
  assert.equal(spawnSync(process.execPath, [AOS, 'check-roles', '--root', root], { encoding: 'utf8', env }).status, 0);
  // The plugin's own repository keeps the short relative form, which exists there.
  assert.match(readFileSync(join(PLUGIN_DIR, '..', '..', 'AGENTS.md'), 'utf8'), /CLI: `node plugins\/analucia\/bin\/aos\.mjs <command>`/);
});

test('the push guard prints only the commands for what differs, with the real repository', () => {
  const root = folder({ url: 'https://example@github.com/example/demo.git', cred: 'other-account' });
  assert.throws(() => checkPush(root), (x) => x.code === 'E_ACCOUNT'
    && x.message.includes('git config credential.https://github.com.username example')
    && !x.message.includes('set-url') && !PLACEHOLDER.test(x.message));
  const wrongUser = folder({ url: 'https://someone@github.com/example/demo.git', cred: 'example' });
  assert.throws(() => checkPush(wrongUser), (x) => x.code === 'E_ACCOUNT'
    && x.message.includes('git remote set-url origin https://example@github.com/example/demo.git') && !x.message.includes('git config'));
  const noOwner = folder({ owner: null, url: 'https://example@github.com/example/demo.git' });
  assert.throws(() => checkPush(noOwner), (x) => x.code === 'E_ACCOUNT' && /node "[^"]+" init/.test(x.message));
});
