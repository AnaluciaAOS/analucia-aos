// ORD-0033: tests of the public checkout (A.1, A.2) and the four fresh-user findings of ORD-0031 (B.1 to B.4).
// Every test works in temporary folders, with a scratch home and a scratch CLAUDE_CONFIG_DIR: the owner's own
// Claude configuration is never read or written.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { reportText, runChecks } from '../lib/checks.mjs';
import * as cli from '../lib/cli.mjs';
import { firstHour } from '../lib/metrics.mjs';
import { LOCALES, catalog, onboardingStarted } from '../lib/onboarding.mjs';
import { logPath, readLog } from '../lib/log.mjs';

// Loaded so that, run against the code before ORD-0033, each test fails on its own instead of the whole file.
const { personLocale, supportedLocale } = await import('../lib/locale.mjs').catch(() => ({}));
const { claudeConfigDir, pluginInstall } = cli;

const PLUGIN = fileURLToPath(new URL('..', import.meta.url));
const AOS = join(PLUGIN, 'bin', 'aos.mjs');
const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' });

// A process environment with a scratch home and a scratch Claude configuration, and a fixed language.
function scratchEnv(extra = {}) {
  const home = mkdtempSync(join(tmpdir(), 'aos-home-'));
  const config = mkdtempSync(join(tmpdir(), 'aos-claude-config-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: config, LC_ALL: 'en_US.UTF-8', ...extra };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CLAUDE_PLUGIN_ROOT;
  return { env, home, config };
}
const freshRepo = () => {
  const root = mkdtempSync(join(tmpdir(), 'aos-fresh-'));
  git(root, 'init', '-q', '-b', 'main');
  return root;
};
const aos = (args, { env, input = '' }) => spawnSync(process.execPath, [AOS, ...args], { encoding: 'utf8', env, input });

// ---------- A.1 and A.2: the public checkout ----------

// A copy of the plugin alone, as a public checkout has it: no core/ specs and no .analucia of this repository.
function publicCopy() {
  const root = mkdtempSync(join(tmpdir(), 'aos-public-'));
  cpSync(PLUGIN, join(root, 'plugins', 'analucia'), { recursive: true });
  return root;
}
const tap = (root, file) => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // a test run of its own, not a subtest of this one
  return spawnSync(process.execPath, ['--test', '--test-reporter=tap', join('plugins', 'analucia', 'tests', file)], { cwd: root, encoding: 'utf8', env });
};
const count = (out, k) => Number((new RegExp(`^# ${k} (\\d+)$`, 'm').exec(out) ?? [])[1]);

test('ORD-0033 A.1: in a public checkout the two repository tests of validate.test.mjs skip and name the missing path; nothing fails', () => {
  const r = tap(publicCopy(), 'validate.test.mjs');
  const out = r.stdout;
  assert.equal(count(out, 'fail'), 0, out.slice(-1500));
  assert.equal(count(out, 'skipped'), 2, out.slice(-1500));
  assert.match(out, /the real orders in \.analucia\/orders pass # SKIP not in this checkout: \.analucia\/orders/);
  assert.match(out, /the repository validates # SKIP not in this checkout: \.analucia\/project\.json, \.analucia\/events\.jsonl/);
});

test('ORD-0033 A.2: in a public checkout the 21 drift tests are reported as skipped with the missing spec, not lost, and nothing crashes', () => {
  const r = tap(publicCopy(), 'drift.test.mjs');
  const out = r.stdout + r.stderr;
  assert.equal(count(out, 'tests'), 21, out.slice(-1500));
  assert.equal(count(out, 'skipped'), 21, out.slice(-1500));
  assert.equal(count(out, 'fail'), 0, out.slice(-1500));
  assert.doesNotMatch(out, /ENOENT/);
  for (const line of out.split('\n').filter((l) => /^ok \d+ /.test(l))) assert.match(line, /# SKIP not in this checkout: \S/, line);
  assert.match(out, /drift: roles matches the specification # SKIP not in this checkout: core\/NOMENCLATURE\.md/);
});

test('ORD-0033 A.2: a spec that is present but malformed fails loudly, with a message', () => {
  const root = publicCopy();
  mkdirSync(join(root, 'core'));
  writeFileSync(join(root, 'core', 'NOMENCLATURE.md'), '# not the specification\n');
  writeFileSync(join(root, 'core', 'SPEC-0003-RULES-ERRORS-RISK-COST.md'), '# not the specification\n');
  const out = tap(root, 'drift.test.mjs').stdout;
  assert.ok(count(out, 'fail') > 0, out.slice(-800));
  assert.match(out, /section 1 not found in NOMENCLATURE\.md/);
  assert.match(out, /section 3 not found in SPEC-0003/);
});

// ---------- B.1 (D-1): the configuration folder, and no other project's path ----------

test('ORD-0033 B.1: the plugin install is read from CLAUDE_CONFIG_DIR when it is set, and init --check never prints another folder', () => {
  const { env, config } = scratchEnv();
  const marker = 'other-project-of-someone';
  const other = join(tmpdir(), marker);
  mkdirSync(join(config, 'plugins'), { recursive: true });
  writeFileSync(join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'analucia@analucia-aos': [{ scope: 'project', projectPath: other }] } }));
  writeFileSync(join(config, 'plugins', 'known_marketplaces.json'), JSON.stringify({ 'analucia-aos': {} }));
  assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: config }), config);
  assert.equal(pluginInstall(config).entries.length, 1);
  const root = freshRepo();
  const r = aos(['init', '--check', '--root', root], { env });
  assert.match(r.stdout, /installed for another folder \(1 in all\), not for this one/, r.stdout);
  assert.ok(!r.stdout.includes(marker), 'the other folder is never printed');
  assert.ok(!readFileSync(join(root, '.analucia', 'views', 'onboarding.md'), 'utf8').includes(marker));
});

// ---------- B.2 (D-2): nothing written before CONFIRM ----------

// Every file of a folder with its content (the .git folder included).
const snapshot = (root) => {
  const out = {};
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(root, p).split(sep).join('/')] = readFileSync(p).toString('base64');
    }
  };
  walk(root);
  return out;
};

// aos init as the owner runs it, at a terminal: stdin marked as a TTY, each answer typed after its prompt.
function interactiveInit(root, env, answer) {
  return new Promise((done) => {
    const p = spawn(process.execPath, ['--import', `data:text/javascript,process.stdin.isTTY=true`, AOS, 'init', '--root', root], { env });
    let stdout = '';
    let stderr = '';
    let seen = 0;
    let prompts = 0;
    p.stdout.on('data', (b) => {
      stdout += b.toString();
      const fresh = stdout.slice(seen);
      if (/> $|: $/.test(fresh)) {
        seen = stdout.length;
        prompts += 1;
        p.stdin.write(`${prompts > 60 ? 'no' : answer(fresh)}\n`);
      }
    });
    p.stderr.on('data', (b) => { stderr += b.toString(); });
    p.on('close', (status) => done({ status, stdout, stderr }));
  });
}
const wizardAnswer = (refuse) => (prompt) => {
  if (/Type CONFIRM to apply: $/.test(prompt)) return refuse ? 'no' : 'CONFIRM';
  if (/Your answers:/.test(prompt)) return '';
  return '1';
};

test('ORD-0033 B.2: an aos init refused at CONFIRM leaves the folder exactly as it was: no event, no file', async () => {
  const { env } = scratchEnv();
  const root = freshRepo();
  const before = snapshot(root);
  const r = await interactiveInit(root, env, wizardAnswer(true));
  assert.match(r.stdout, /Question 15 of 15/, r.stdout.slice(-600));
  assert.match(r.stderr, /E_NOT_CONFIRMED/, r.stderr);
  assert.deepEqual(snapshot(root), before);
});

test('ORD-0033 B.2: approved, onboarding.started is the first event of aos init and keeps when the interview began', async () => {
  const { env } = scratchEnv();
  const root = freshRepo();
  const r = await interactiveInit(root, env, wizardAnswer(false));
  assert.match(r.stdout, /Type CONFIRM to apply/, r.stdout.slice(-600));
  const events = readLog(root).events;
  assert.equal(events[0].type, 'onboarding.started');
  assert.match(events[0].payload.started_at, /^\d{4}-\d\d-\d\dT/);
  assert.ok(Date.parse(events[0].payload.started_at) <= Date.parse(events[0].ts));
});

test('ORD-0033 B.2: the first hour counts from when the interview began (started_at), not from the CONFIRM', () => {
  const root = mkdtempSync(join(tmpdir(), 'aos-fh-'));
  mkdirSync(join(root, '.analucia'));
  writeFileSync(join(root, '.analucia', 'project.json'), '{"wip_limit":1,"timezone":"UTC"}\n');
  writeFileSync(logPath(root), '');
  // The event as aos init now writes it: appended at CONFIRM (10:00), the interview began at 09:30.
  onboardingStarted(root, { now: new Date('2026-01-01T10:00:00Z'), startedAt: new Date('2026-01-01T09:30:00Z') });
  const [started] = readLog(root).events;
  assert.match(started.payload.started_at, /09:30/);
  const ev = (type, actor, subject, payload, ts) => ({ type, actor, subject, payload, ts });
  const events = [
    started,
    ev('record.created', 'director', 'ORD-0001', { kind: 'build' }, '2026-01-01T10:05:00Z'),
    ev('evidence.attached', 'executor', 'ORD-0001', { level: 'derived', path: 'r.md' }, '2026-01-01T10:20:00Z'),
    ev('order.state_changed', 'owner', 'ORD-0001', { from: 'verified', to: 'closed' }, '2026-01-01T10:30:00Z'),
  ];
  const m = firstHour(events);
  assert.equal(m.elapsed.minutes, 60);
  assert.match(m.started.ts, /09:30/);
});

// ---------- B.3 (D-3): one locale fallback ----------

test('ORD-0033 B.3: one fallback: flag, project, LC_ALL, LC_MESSAGES, LANG, platform, en; only supported locales', () => {
  const none = () => null;
  assert.equal(supportedLocale('es_PE.UTF-8'), 'es');
  assert.equal(supportedLocale('pt-BR'), 'pt');
  assert.equal(supportedLocale('zh_CN.UTF-8'), 'zh-Hans');
  assert.equal(supportedLocale('C'), null);
  assert.equal(supportedLocale('fr_FR.UTF-8'), null);
  const root = mkdtempSync(join(tmpdir(), 'aos-loc-'));
  mkdirSync(join(root, '.analucia'));
  writeFileSync(join(root, '.analucia', 'project.json'), '{"wip_limit":1,"locale":"hi"}\n');
  assert.equal(personLocale(root, { flag: 'pt', env: { LANG: 'es_ES.UTF-8' }, platform: none }), 'pt');
  assert.equal(personLocale(root, { env: { LANG: 'es_ES.UTF-8' }, platform: none }), 'hi');
  assert.equal(personLocale(null, { env: { LC_ALL: 'fr_FR', LC_MESSAGES: 'pt_BR', LANG: 'es_ES' }, platform: none }), 'pt');
  assert.equal(personLocale(null, { env: { LANG: 'es_ES.UTF-8' }, platform: () => 'hi-IN' }), 'es');
  assert.equal(personLocale(null, { env: {}, platform: () => 'hi-IN' }), 'hi');
  assert.equal(personLocale(null, { env: {}, platform: none }), 'en');
  assert.deepEqual(LOCALES.map((l) => supportedLocale(l)), LOCALES);
});

test('ORD-0033 B.3: same folder, same environment: the SessionStart hook and aos init --check speak the same language', () => {
  for (const [lang, l] of [['pt_BR.UTF-8', 'pt'], ['hi_IN.UTF-8', 'hi'], ['en_US.UTF-8', 'en']]) {
    const { env } = scratchEnv({ LC_ALL: lang });
    const root = freshRepo();
    const t = catalog(l);
    const hook = aos(['hook', 'session-start'], { env, input: JSON.stringify({ session_id: 's', source: 'startup', cwd: root }) });
    assert.ok(hook.stdout.startsWith(t('session.not_initialised', { cwd: '', cmd: '' }).split(':')[0]), `${l}: hook: ${hook.stdout}`);
    const check = aos(['init', '--check', '--root', root], { env });
    assert.ok(check.stdout.startsWith(t('check.title')), `${l}: init --check: ${check.stdout.slice(0, 120)}`);
  }
});

// ---------- B.4 (D-4): branch protection with no remote ----------

test('ORD-0033 B.4: with no remote, branch protection says there is no remote yet and what to do, in every locale; the token wording stays for a remote', () => {
  const noInstall = { entries: [], marketplaceKnown: true };
  const root = freshRepo();
  const results = runChecks(root, { lsRemote: () => ({ ok: false, ms: 0 }), install: noInstall }).results;
  const bp = results.find((r) => r.name === 'branch_protection');
  assert.equal(bp.status, 'WARN');
  for (const l of LOCALES) {
    const t = catalog(l);
    const text = reportText(results, l);
    assert.ok(text.includes(t('branch_protection.no_remote')), l);
    assert.ok(!text.includes(t('branch_protection.warn')), `${l}: no token wording without a remote`);
    assert.match(text, /init --check/, `${l}: the command to run the check again`);
  }
  const withRemote = freshRepo();
  git(withRemote, 'remote', 'add', 'origin', 'https://example@github.com/example/demo.git');
  const text = reportText(runChecks(withRemote, { lsRemote: () => ({ ok: true, ms: 1 }), install: noInstall }).results, 'en');
  assert.match(text, /branch protection cannot be checked without a token on a private repository/);
  assert.ok(existsSync(join(withRemote, '.git')));
});
