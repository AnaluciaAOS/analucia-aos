// ORD-0044 part 7 (AMD-0023, OBS-193): the permission profile is inverted. Every shell command and every edit is allowed,
// a short list of dangerous things is denied, and nothing asks. `aos permissions write` writes it (`--local` for the
// local settings); only the `permissions` key changes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PROFILE, permissionsWrite, profileRules } from '../lib/permissions.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env };
delete env.CLAUDE_PROJECT_DIR; delete env.CLAUDE_CODE_SESSION_ID; delete env.CLAUDECODE;
const root = () => {
  const r = mkdtempSync(join(tmpdir(), 'aos-profile-'));
  mkdirSync(join(r, '.analucia'), { recursive: true });
  writeFileSync(join(r, '.analucia', 'project.json'), JSON.stringify({ wip_limit: 1, github_owner: 'example' }));
  return r;
};
const read = (r, rel = '.claude/settings.json') => JSON.parse(readFileSync(join(r, rel), 'utf8'));
const denies = (list, ...rules) => { for (const x of rules) assert.ok(list.includes(x), `deny has ${x}`); };

test('the profile allows every shell command (Bash and PowerShell) and every edit and write', () => {
  assert.deepEqual(PROFILE.allow, ['Bash', 'PowerShell', 'Edit', 'Write']);
  const r = root();
  permissionsWrite(r, { marketplace: null });
  const s = read(r);
  for (const a of PROFILE.allow) assert.ok(s.permissions.allow.includes(a), a);
});

test('there is no ask list, for any profile', () => {
  assert.deepEqual(PROFILE.ask, []);
  for (const p of ['low', 'medium', 'high']) assert.deepEqual(profileRules(p).ask, [], p);
  const r = root();
  permissionsWrite(r, { marketplace: null, profile: 'high' });
  assert.deepEqual(read(r).permissions.ask, []);
});

test('the deny list: force pushes in every form, in both shells', () => {
  const { deny } = profileRules();
  for (const tool of ['Bash', 'PowerShell']) denies(deny, `${tool}(git push --force *)`, `${tool}(git push * --force*)`, `${tool}(git push -f *)`, `${tool}(git push * -f*)`, `${tool}(git push * +*)`);
});

test('the deny list: a push to main or master by name, HEAD:main and refspec', () => {
  const { deny } = profileRules();
  for (const b of ['main', 'master']) {
    for (const tool of ['Bash', 'PowerShell']) denies(deny, `${tool}(git push * ${b})`, `${tool}(git push * *:${b})`, `${tool}(git push * HEAD:${b})`, `${tool}(git push * refs/heads/${b})`, `${tool}(git push * *:refs/heads/${b})`);
  }
});

test('the deny list: git reset --hard and the mass deletes', () => {
  const { deny } = profileRules();
  denies(deny, 'Bash(git reset --hard *)', 'PowerShell(git reset --hard *)');
  denies(deny, 'Bash(rm -rf *)', 'Bash(rm -fr *)', 'Bash(rm -r *)', 'PowerShell(Remove-Item * -Recurse*)', 'Bash(del /s *)', 'Bash(rmdir /s *)', 'PowerShell(rmdir /s *)');
});

test('the deny list: secrets are not read, by the Read tool or through the shell', () => {
  const { deny } = profileRules();
  denies(deny, 'Read(**/.env)', 'Read(**/.env.*)', 'Read(**/*.pem)', 'Read(**/*.key)');
  denies(deny, 'Bash(cat *.env)', 'Bash(cat *.env.*)', 'Bash(type *.pem)', 'PowerShell(Get-Content *.key)', 'PowerShell(Get-Content *.env)');
});

test('the deny list: no writing to a real database', () => {
  const { deny } = profileRules();
  denies(deny, 'Bash(psql *)', 'Bash(pg_restore *)', 'Bash(mysql *)', 'Bash(prisma migrate *)', 'Bash(npx prisma db push*)', 'PowerShell(psql *)');
});

test('nothing in the allow list is also denied, and the deny list repeats no rule', () => {
  const r = profileRules();
  assert.equal(new Set(r.deny).size, r.deny.length);
  for (const a of r.allow) assert.ok(!r.deny.includes(a), a);
});

test('other keys of the file are kept, only permissions changes, and the old rules are replaced', () => {
  const r = root();
  mkdirSync(join(r, '.claude'));
  writeFileSync(join(r, '.claude', 'settings.json'), JSON.stringify({ model: 'keep-me', env: { A: '1' }, permissions: { defaultMode: 'default', allow: ['Edit(/**)', 'Bash(make *)'], ask: ['Bash(git push)'], deny: ['Bash(my-own *)'] }, enabledPlugins: { 'x@y': true } }));
  permissionsWrite(r, { marketplace: null });
  const s = read(r);
  assert.equal(s.model, 'keep-me');
  assert.deepEqual(s.env, { A: '1' });
  assert.deepEqual(s.enabledPlugins, { 'x@y': true });
  assert.equal(s.permissions.defaultMode, 'default');
  assert.ok(s.permissions.allow.includes('Bash(make *)') && !s.permissions.allow.includes('Edit(/**)'));
  assert.ok(s.permissions.deny.includes('Bash(my-own *)'));
  assert.deepEqual(s.permissions.ask, []);
  assert.equal(permissionsWrite(r, { marketplace: null }).changed, false, 'idempotent');
});

test('--local writes the same profile in .claude/settings.local.json and leaves the versioned file alone; --permissions-only leaves the plugin keys out', () => {
  const r = root();
  mkdirSync(join(r, '.claude'));
  const versioned = JSON.stringify({ model: 'x' });
  writeFileSync(join(r, '.claude', 'settings.json'), versioned);
  const l = spawnSync(process.execPath, [AOS, 'permissions', 'write', '--local', '--root', r], { encoding: 'utf8', env, input: '' });
  assert.equal(l.status, 0, l.stderr);
  const s = read(r, '.claude/settings.local.json');
  assert.deepEqual(s.permissions.allow, PROFILE.allow);
  assert.deepEqual(s.permissions.ask, []);
  denies(s.permissions.deny, 'Bash(git reset --hard *)', 'Read(**/.env)');
  assert.equal(readFileSync(join(r, '.claude', 'settings.json'), 'utf8'), versioned);
  const o = spawnSync(process.execPath, [AOS, 'permissions', 'write', '--permissions-only', '--root', r], { encoding: 'utf8', env, input: '' });
  assert.equal(o.status, 0, o.stderr);
  const v = read(r);
  assert.deepEqual(Object.keys(v).sort(), ['model', 'permissions']);
});
