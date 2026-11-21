// ORD-0043 part 16 (OBS-177), AMD-0016 section 2 and AMD-0017 section 2: a git push that names a branch that is not
// protected does not ask; one that names a protected branch, or names no branch, asks; force pushes stay denied. The
// push guard is the second lock: inside an agent session a protected branch as destination is refused (E_PROTECTED_PUSH),
// unless it is the owner's own push from `aos sign`. `aos permissions write --local` writes .claude/settings.local.json.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkPush, parsePushRefs } from '../lib/guards.mjs';
import { permissionsWrite, profileRules, pushAsk, PUSH_ALLOW } from '../lib/permissions.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env };
delete env.CLAUDE_PROJECT_DIR; delete env.CLAUDE_CODE_SESSION_ID; delete env.CLAUDECODE; delete env.AOS_OWNER_PUSH;
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

function project(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aos-pushperm-'));
  mkdirSync(join(root, '.analucia'), { recursive: true });
  writeFileSync(join(root, '.analucia', 'project.json'), JSON.stringify({ wip_limit: 1, github_owner: 'example', ...extra }));
  writeFileSync(join(root, '.analucia', 'events.jsonl'), '');
  git(root, 'init', '-q');
  git(root, 'remote', 'add', 'origin', 'https://example@github.com/example/shop.git');
  git(root, 'config', 'credential.https://github.com.username', 'example');
  return root;
}

test('the profile allows a push that names a branch, asks for a protected branch or no branch, and still denies force', () => {
  const r = profileRules('medium');
  for (const a of PUSH_ALLOW) assert.ok(r.allow.includes(a), a);
  assert.ok(!r.ask.includes('Bash(git push *)'), 'no broad ask: it would beat the allow');
  for (const a of ['Bash(git push)', 'Bash(git push origin)', 'Bash(git push * main)', 'Bash(git push * *:main)', 'Bash(git push * master)']) assert.ok(r.ask.includes(a), a);
  for (const d of ['Bash(git push --force *)', 'Bash(git push * --force*)', 'Bash(git push -f *)']) assert.ok(r.deny.includes(d), d);
  // The protected branches of the project replace the default two.
  const custom = pushAsk(['release']);
  assert.ok(custom.includes('Bash(git push * release)') && !custom.includes('Bash(git push * main)'));
  // The high profile keeps asking for every push.
  assert.ok(profileRules('high').ask.includes('Bash(git push *)'));
});

test('permissions write uses protected_branches of project.json, and the old broad ask is replaced', () => {
  const root = project({ protected_branches: ['trunk'] });
  mkdirSync(join(root, '.claude'));
  writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ permissions: { ask: ['Bash(git push *)', 'Bash(my-own *)'], allow: [], deny: [] } }));
  const w = permissionsWrite(root, { marketplace: null });
  assert.equal(w.path, '.claude/settings.json');
  const s = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'));
  assert.ok(!s.permissions.ask.includes('Bash(git push *)'));
  assert.ok(s.permissions.ask.includes('Bash(my-own *)'), 'a rule of the owner is kept');
  assert.ok(s.permissions.ask.includes('Bash(git push * trunk)') && !s.permissions.ask.includes('Bash(git push * main)'));
  assert.ok(s.permissions.allow.includes('Bash(git push origin *)'));
  assert.equal(permissionsWrite(root, { marketplace: null }).changed, false);
});

test('--local writes .claude/settings.local.json only, with the permission rules and no plugin key; the versioned file is not touched', () => {
  const root = project();
  const r = spawnSync(process.execPath, [AOS, 'permissions', 'write', '--local', '--root', root], { encoding: 'utf8', env, input: '' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /settings\.local\.json written/);
  assert.equal(existsSync(join(root, '.claude', 'settings.json')), false);
  const s = JSON.parse(readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8'));
  assert.ok(s.permissions.allow.includes('Bash(git push origin *)'));
  assert.ok(s.permissions.ask.includes('Bash(git push * main)'));
  assert.equal(s.enabledPlugins, undefined);
  assert.equal(s.extraKnownMarketplaces, undefined);
  // Without --local the versioned profile is written, as before.
  const v = spawnSync(process.execPath, [AOS, 'permissions', 'write', '--root', root], { encoding: 'utf8', env, input: '' });
  assert.equal(v.status, 0, v.stderr);
  assert.ok(existsSync(join(root, '.claude', 'settings.json')));
});

test('the pre-push input names the refs; only a protected branch is a problem', () => {
  const input = 'refs/heads/ord-1 aaaa refs/heads/ord-1 bbbb\nrefs/heads/x cccc refs/heads/main dddd\n';
  assert.deepEqual(parsePushRefs(input), ['refs/heads/ord-1', 'refs/heads/main']);
  assert.deepEqual(parsePushRefs(''), []);
});

test('the second lock: an agent session cannot push a protected branch; its own branch and the owner sign-off pass', () => {
  const root = project();
  writeFileSync(join(root, 'a.txt'), 'a\n');
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'c\n\nAnalucia-Order: ORD-0001');
  const agent = { CLAUDECODE: '1' };
  const main = ['refs/heads/work aaaa refs/heads/main bbbb'];
  assert.throws(() => checkPush(root, { refs: parsePushRefs(main[0]), env: agent }), (x) => x.code === 'E_PROTECTED_PUSH');
  assert.throws(() => checkPush(root, { refs: ['refs/heads/master'], env: { CLAUDE_CODE_SESSION_ID: 's1' } }), (x) => x.code === 'E_PROTECTED_PUSH');
  // Its own branch: not refused by this lock (the other checks may still speak, but not with this code).
  const own = (() => { try { return checkPush(root, { refs: ['refs/heads/ord-1'], env: agent }); } catch (x) { return x; } })();
  assert.notEqual(own.code, 'E_PROTECTED_PUSH');
  // The owner's sign-off: AOS_OWNER_PUSH=1. And a push outside any agent session.
  for (const e of [{ ...agent, AOS_OWNER_PUSH: '1' }, {}]) {
    const r = (() => { try { return checkPush(root, { refs: ['refs/heads/main'], env: e }); } catch (x) { return x; } })();
    assert.notEqual(r.code, 'E_PROTECTED_PUSH');
  }
  // protected_branches of the project decides.
  const custom = project({ protected_branches: ['release'] });
  assert.throws(() => checkPush(custom, { refs: ['refs/heads/release'], env: agent }), (x) => x.code === 'E_PROTECTED_PUSH');
  const free = (() => { try { return checkPush(custom, { refs: ['refs/heads/main'], env: agent }); } catch (x) { return x; } })();
  assert.notEqual(free.code, 'E_PROTECTED_PUSH');
});

test('the error has its page and its entry in the index, and aos check-push reads the refs from its standard input', () => {
  const page = join(fileURLToPath(new URL('../docs/errors/', import.meta.url)), 'E_PROTECTED_PUSH.md');
  assert.ok(existsSync(page));
  assert.match(readFileSync(fileURLToPath(new URL('../docs/INDEX.md', import.meta.url)), 'utf8'), /\[E_PROTECTED_PUSH\]\(errors\/E_PROTECTED_PUSH\.md\)/);
  const root = project();
  const r = spawnSync(process.execPath, [AOS, 'check-push', 'origin', 'https://example@github.com/example/shop.git', '--root', root], {
    encoding: 'utf8', env: { ...env, CLAUDECODE: '1' }, input: 'refs/heads/work aaaa refs/heads/main bbbb\n',
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /E_PROTECTED_PUSH/);
  const ok = spawnSync(process.execPath, [AOS, 'check-push', 'origin', 'https://example@github.com/example/shop.git', '--root', root], {
    encoding: 'utf8', env: { ...env, CLAUDECODE: '1', AOS_OWNER_PUSH: '1' }, input: 'refs/heads/work aaaa refs/heads/main bbbb\n',
  });
  assert.doesNotMatch(ok.stderr, /E_PROTECTED_PUSH/);
});
