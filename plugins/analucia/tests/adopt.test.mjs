// SPEC-0006 §7: the adoption audit on temporary repositories built at run time. Fake secrets are assembled from
// parts, so this file itself passes the secret guard.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { needsAudit, runAudit } from '../lib/adopt.mjs';
import { logPath, readLog } from '../lib/log.mjs';
import { CONTEXT_PATTERNS, TOKEN_PATTERNS, secretKindsIn } from '../lib/secret-patterns.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
delete env.CLAUDE_PROJECT_DIR;
const aos = (root, args) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input: '', env });
const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' });
const fakeToken = () => ['gh', 'p_', 'Kq3', 'Lm9Np2Rs5Tv8', 'Wx1Yz4Ab7Cd0', 'Ef6Gh2Ij5Kl8'].join('');

// A repo with a README, a source file, tests, and a pushed remote; `files` are committed on top.
function repo({ remote = true, files = {}, log = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aos-adopt-'));
  git(root, 'init', '-q', '-b', 'main');
  if (log) {
    mkdirSync(join(root, '.analucia'));
    writeFileSync(join(root, '.analucia', 'project.json'), '{"wip_limit":1,"locale":"en"}\n');
    writeFileSync(logPath(root), '');
  }
  writeFileSync(join(root, 'README.md'), '# demo\n\nRun `src/app.js`.\n');
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'tests'));
  writeFileSync(join(root, 'src', 'app.js'), 'export const x = 1;\n');
  writeFileSync(join(root, 'tests', 'app.test.js'), 'import "../src/app.js";\n');
  for (const [p, data] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), data);
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  if (remote) {
    const bare = mkdtempSync(join(tmpdir(), 'aos-adopt-bare-'));
    git(bare, 'init', '-q', '--bare');
    git(root, 'remote', 'add', 'origin', bare);
    git(root, 'push', '-q', '--no-verify', 'origin', 'main');
  }
  return root;
}
const checks = (audit) => audit.findings.map((f) => f.check);
// Every 6-character window of the secret: none may appear anywhere in the output.
const noPartOf = (secret, ...texts) => {
  const all = texts.join('\n');
  for (let i = 0; i + 6 <= secret.length; i++) assert.ok(!all.includes(secret.slice(i, i + 6)), `part "${secret.slice(i, i + 6)}…" leaked`);
};

test('a secret in the working tree gives AD-SECRET-TREE without printing it (no part, in output, report or event)', () => {
  const secret = fakeToken();
  const root = repo({ files: { 'src/config.js': `export const key = "${secret}";\n` } });
  const r = aos(root, ['adopt']);
  assert.equal(r.status, 1, r.stderr);
  const report = readFileSync(join(root, '.analucia', 'views', 'adoption.md'), 'utf8');
  assert.match(report, /AD-\d{3} HIGH AD-SECRET-TREE src\/config\.js:1: a github_token secret is in a tracked file/);
  assert.match(report, /Rotate the github_token credential found in src\/config\.js \(line 1\)\. Risk high, owner only/);
  noPartOf(secret.slice(4), r.stdout, r.stderr, report, readFileSync(logPath(root), 'utf8'));
});

test('a secret added and deleted in an old commit gives AD-SECRET-HISTORY with the first commit, and nothing else', () => {
  const secret = fakeToken();
  const root = repo();
  writeFileSync(join(root, 'src', 'old.js'), `export const k = "${secret}";\n`);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'add');
  const introduced = git(root, 'rev-parse', '--short=7', 'HEAD').stdout.trim();
  writeFileSync(join(root, 'src', 'old.js'), `export const k = "${secret}"; // touched\n`);
  git(root, 'commit', '-q', '-am', 'touch');
  git(root, 'rm', '-q', 'src/old.js');
  git(root, 'commit', '-q', '-m', 'delete');
  git(root, 'push', '-q', '--no-verify', 'origin', 'main');
  const audit = runAudit(root);
  const secrets = audit.findings.filter((f) => f.check.startsWith('AD-SECRET'));
  assert.equal(secrets.length, 1, JSON.stringify(secrets));
  assert.deepEqual([secrets[0].check, secrets[0].kind, secrets[0].file, secrets[0].commit, secrets[0].line], ['AD-SECRET-HISTORY', 'github_token', 'src/old.js', introduced, 1]);
  const r = aos(root, ['adopt']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /AD-SECRET-HISTORY src\/old\.js:1 @[0-9a-f]{7}: a github_token secret was added in commit/);
  assert.match(r.stdout, /After rotating, remove the rotated secrets from the git history/);
  noPartOf(secret.slice(4), r.stdout, readFileSync(logPath(root), 'utf8'));
});

test('a tracked .env gives AD-ENV; an untracked, unignored one too; templates do not', () => {
  const root = repo({ files: { '.env': ['API', '_KEY', '=', 'abc'].join('') + '\n', '.env.example': 'API_KEY=changeme\n' } });
  writeFileSync(join(root, '.env.local'), 'X=1\n');
  const a = runAudit(root);
  const env = a.findings.filter((f) => f.check === 'AD-ENV').map((f) => [f.kind, f.file]);
  assert.deepEqual(env, [['env_tracked', '.env'], ['env_unignored', '.env.local']]);
  assert.ok(a.findings.some((f) => f.check === 'AD-SECRET-TREE' && f.kind === 'env_secret_assignment' && f.file === '.env'), 'the assignment in .env is a secret finding too');
  assert.ok(!a.findings.some((f) => f.file === '.env.example'), 'templates are not reported');
});

test('a 6 MB tracked zip gives AD-HYGIENE', () => {
  const root = repo({ files: { 'dist/build.zip': Buffer.alloc(6 * 1024 * 1024, 7) } });
  const f = runAudit(root).findings.find((x) => x.check === 'AD-HYGIENE');
  assert.deepEqual([f.severity, f.kind, f.file, f.detail.vars.size], ['medium', 'large_file', 'dist/build.zip', 6]);
});

test('a repository with no remote gives AD-SPOF', () => {
  const root = repo({ remote: false });
  const f = runAudit(root).findings.find((x) => x.check === 'AD-SPOF');
  assert.deepEqual([f.severity, f.kind], ['high', 'no_remote']);
  const ahead = repo();
  writeFileSync(join(ahead, 'src', 'b.js'), 'export const y = 2;\n');
  git(ahead, 'add', '-A');
  git(ahead, 'commit', '-q', '-m', 'local only');
  assert.deepEqual(runAudit(ahead).findings.filter((x) => x.check === 'AD-SPOF').map((x) => x.kind), ['unpushed_commits']);
});

test('a clean repository exits 0 and reports not_verified for what it cannot check', () => {
  const root = repo();
  const r = aos(root, ['adopt']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const audit = runAudit(root);
  assert.equal(audit.counts.high, 0);
  assert.deepEqual(audit.notVerified.map((n) => n.check).sort(), ['AD-BACKUP', 'AD-BRANCH', 'AD-TESTS']);
  const notVerified = r.stdout.slice(r.stdout.indexOf('## Not verified'));
  assert.match(notVerified, /- AD-BRANCH: Branch protection is not visible/);
  assert.match(notVerified, /- AD-TESTS: A test command exists \(tests\); it is not run, because the audit is read only/);
  const e = readLog(root).events.at(-1);
  assert.equal(e.type, 'adoption.audited');
  assert.equal(e.payload.level, 'observed');
  assert.deepEqual(Object.keys(e.payload.baseline), ['commits', 'tracked_files', 'tests_found', 'last_commit_unix', 'languages']);
  for (const v of [e.payload.baseline.commits, e.payload.baseline.tracked_files, e.payload.baseline.tests_found, e.payload.baseline.last_commit_unix]) assert.equal(typeof v, 'number');
  assert.ok(!JSON.stringify(e.payload).includes(root.replace(/\\/g, '/')) && !JSON.stringify(e.payload).includes(tmpdir()), 'no paths outside the repo');
  assert.equal(aos(root, ['validate']).status, 0);
});

test('two runs give the same findings', () => {
  const secret = fakeToken();
  const root = repo({ files: { 'src/k.js': `const k = "${secret}";\n`, 'migrations/001_init.sql': 'x', 'migrations/001_users.sql': 'y', '.env': 'A=1\n' } });
  const a = runAudit(root);
  const b = runAudit(root);
  assert.deepEqual(b.findings, a.findings);
  assert.deepEqual(b.notVerified, a.notVerified);
  assert.ok(checks(a).includes('AD-HYGIENE'), 'duplicated migration prefix');
});

test('the output and the event never contain the fake secret, in any part (token and context patterns)', () => {
  const token = fakeToken();
  const password = ['S3cr', 'et-', 'Va1ue', '-', '9x8y7z'].join('');
  const root = repo({ files: {
    'src/a.js': `const t = "${token}";\n`,
    'config/db.env': `DB_PASSWORD=${password}\n`,
    'docs/setup.md': `Clone https://deploy:${password}@git.example.com/repo.git\n`,
  } });
  const r = aos(root, ['adopt', '--locale', 'es']);
  assert.equal(r.status, 1);
  const report = readFileSync(join(root, '.analucia', 'views', 'adoption.md'), 'utf8');
  assert.match(report, /^# Auditoría de adopción/);
  const kinds = runAudit(root).findings.filter((f) => f.check === 'AD-SECRET-TREE').map((f) => f.kind).sort();
  assert.deepEqual(kinds, ['env_secret_assignment', 'github_token', 'url_credential']);
  for (const s of [token.slice(4), password]) noPartOf(s, r.stdout, r.stderr, report, readFileSync(logPath(root), 'utf8'));
});

test('exit 2 when the audit cannot run (not a git work tree)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aos-adopt-nogit-'));
  const r = aos(dir, ['adopt']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /aos adopt: E_ADOPT_UNAVAILABLE [^\n]*\n {2}next \(owner\)/);
});

test('one shared list: the guard and the audit use the same token patterns, and the JSON mirror equals the module', () => {
  const mirror = JSON.parse(readFileSync(fileURLToPath(new URL('../core/secret-patterns.json', import.meta.url)), 'utf8'));
  const mine = Object.fromEntries(Object.entries(mirror).filter(([k]) => !k.startsWith('$')).map(([k, v]) => [k, v.pattern]));
  assert.deepEqual(mine, Object.fromEntries(Object.entries(TOKEN_PATTERNS).map(([k, v]) => [k, v.pattern])));
  assert.ok(secretKindsIn('src/x.js', `k="${fakeToken()}"`).includes('github_token'));
  assert.deepEqual(secretKindsIn('.env.local', 'PASSWORD=${DB_PASSWORD}'), [], 'placeholders are not secrets');
  assert.deepEqual(secretKindsIn('src/x.js', 'PASSWORD=real'), [], 'assignments count only in .env-like files');
  assert.deepEqual(secretKindsIn('README.md', 'use https://user:secret@host/x'), [], 'documented placeholder credential');
  assert.ok(Object.keys(CONTEXT_PATTERNS).length === 2);
});

test('aos init audits only projects over 20 commits or 50 tracked files', () => {
  const small = repo();
  assert.equal(needsAudit(small), false);
  const many = repo({ files: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`src/m${i}.js`, `export const v = ${i};\n`])) });
  assert.equal(needsAudit(many), true);
});
