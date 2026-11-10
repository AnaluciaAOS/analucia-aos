// SPEC-0005 §1–§4: aos init (interview, answers file, dry run), catalogs, configuration, adoption safety.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { logPath, readLog } from '../lib/log.mjs';
import { DIRECTOR_SCOPE, LOCALES, QUESTIONS, interview, runInit } from '../lib/onboarding.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const I18N = fileURLToPath(new URL('../i18n/', import.meta.url));
const ES = fileURLToPath(new URL('./fixtures/onboarding/answers-es.json', import.meta.url));
const env = { ...process.env };
delete env.CLAUDE_PROJECT_DIR;
const aos = (root, args) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input: '', env });
const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const CONFIRM = { isTTY: true, ask: async () => 'CONFIRM' };

function project({ claude } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aos-init-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'remote', 'add', 'origin', 'https://example@github.com/example/demo.git');
  mkdirSync(join(root, '.analucia'));
  writeFileSync(join(root, '.analucia', 'project.json'), '{"wip_limit":1,"deploy":{"policy":"batch"}}\n');
  writeFileSync(logPath(root), '');
  if (claude !== undefined) writeFileSync(join(root, 'CLAUDE.md'), claude);
  return root;
}
// Every file under root (except .git), with its bytes, plus the git config value the hooks set.
function snapshot(root) {
  const out = {};
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      if (f === '.git') continue;
      const p = join(d, f);
      if (statSync(p).isDirectory()) { out[`${relative(root, p)}/`] = 'dir'; walk(p); } else out[relative(root, p)] = readFileSync(p, 'utf8');
    }
  };
  walk(root);
  out['git:core.hooksPath'] = git(root, 'config', '--local', '--get', 'core.hooksPath').stdout.trim();
  return out;
}
const esAnswers = () => JSON.parse(readFileSync(ES, 'utf8')).answers;
const lines = [];
const out = (s) => lines.push(s);

test('a dry run with the es answers file writes nothing, and prints the plan in Spanish', () => {
  const root = project();
  const before = snapshot(root);
  const r = aos(root, ['init', '--answers', ES, '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Plan de arranque/);
  assert.match(r.stdout, /Respuestas[\s\S]*Configuración[\s\S]*Simulación: no se escribió nada\./);
  assert.match(r.stdout, /budget_monthly_usd: Presupuesto desconocido: se registra 0 y las alertas de costo quedan apagadas\./);
  assert.match(r.stdout, /Perfil de permisos \(\.claude\/settings\.json\): creado/);
  assert.deepEqual(snapshot(root), before);
});

test('applying the same answers twice gives no diff (files, git config and the log)', async () => {
  const root = project();
  await runInit(root, { provided: esAnswers(), locale: 'es', ...CONFIRM, out, now: new Date('2026-10-21T10:00:00-05:00') });
  const first = snapshot(root);
  assert.ok(existsSync(join(root, '.analucia', 'onboarding.json')));
  for (const f of ['orders', 'decisions', 'specs', 'observations', 'amendments', 'asks', 'evidence', 'views']) assert.ok(existsSync(join(root, '.analucia', f)), f);
  const pj = JSON.parse(readFileSync(join(root, '.analucia', 'project.json'), 'utf8'));
  assert.deepEqual(pj, {
    wip_limit: 1, deploy: { policy: 'batch' }, github_owner: 'example', locale: 'es', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, hosting: 'later',
  }, 'foreign keys kept; budget unknown → no budget key, alerts off; the owner time zone recorded (ORD-0012)');
  assert.equal(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
  assert.match(readFileSync(join(root, 'AGENTS.md'), 'utf8'), /<!-- analucia:begin -->/);
  assert.match(readFileSync(join(root, '.gitattributes'), 'utf8'), /^\.analucia\/\*\* text eol=lf$/m);
  assert.equal(first['git:core.hooksPath'], '.githooks');
  const events = readLog(root).events;
  assert.deepEqual(events.map((e) => [e.type, e.actor]), [['role.declared', 'director'], ['operation.logged', 'owner'], ['hosting.chosen', 'owner']]);
  assert.deepEqual(events[0].payload, { role: 'director', scope: DIRECTOR_SCOPE });
  assert.equal(events[1].payload.operation, 'onboarding');
  assert.deepEqual(events[1].payload.changed, QUESTIONS.map((q) => q.key));
  const onb = JSON.parse(readFileSync(join(root, '.analucia', 'onboarding.json'), 'utf8'));
  assert.equal(onb.locale, 'es');
  assert.deepEqual(Object.keys(onb.answers.purpose), ['value', 'source', 'at']);

  await runInit(root, { provided: esAnswers(), locale: 'es', ...CONFIRM, out, now: new Date('2026-10-22T10:00:00-05:00') });
  assert.deepEqual(snapshot(root), first, 'second apply: byte-identical');
  assert.equal(readLog(root).events.length, 3, 'no new events when nothing changed');
});

test('an unknown answer value, an unknown key and a missing purpose are refused, and nothing is written', async () => {
  const root = project();
  const before = snapshot(root);
  await assert.rejects(runInit(root, { provided: { ...esAnswers(), in_use: 'maybe' }, locale: 'es', ...CONFIRM, out }), (x) => x.code === 'E_ANSWER_VALUE' && /in_use: "maybe"/.test(x.message));
  await assert.rejects(runInit(root, { provided: { ...esAnswers(), wip_limit: 0 }, locale: 'es', ...CONFIRM, out }), (x) => x.code === 'E_ANSWER_VALUE');
  await assert.rejects(runInit(root, { provided: { ...esAnswers(), github_owner: 'not an account!' }, locale: 'es', ...CONFIRM, out }), (x) => x.code === 'E_ANSWER_VALUE');
  await assert.rejects(runInit(root, { provided: { ...esAnswers(), colour: 'blue' }, locale: 'es', ...CONFIRM, out }), (x) => x.code === 'E_UNKNOWN_KEY');
  await assert.rejects(runInit(root, { provided: { purpose: 'unknown' }, locale: 'en', ...CONFIRM, out }), (x) => x.code === 'E_MISSING_FIELD');
  const bad = join(root, 'bad.json');
  writeFileSync(bad, JSON.stringify({ locale: 'es', answers: { ...esAnswers(), approve_from: 'email' } }));
  const r = aos(root, ['init', '--answers', bad, '--dry-run']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /aos init: E_ANSWER_VALUE approve_from[^\n]*\n {2}next \(owner\)/);
  const { 'bad.json': _ignored, ...after } = snapshot(root);
  assert.deepEqual(after, before);
});

test('the safe defaults are applied when answers are unknown', async () => {
  const root = project();
  const unknown = Object.fromEntries(QUESTIONS.map((q) => [q.key, 'unknown']));
  unknown.purpose = 'Demo shop';
  const r = await runInit(root, { provided: unknown, locale: 'en', ...CONFIRM, out });
  const a = Object.fromEntries(Object.entries(r.resolved.answers).map(([k, v]) => [k, v.value]));
  assert.deepEqual(a, {
    purpose: 'Demo shop', in_use: 'yes', end_user_input: 'unsure', how_verified: 'person', never_leaves: [],
    delivered_when: 'when the checks pass and the owner looked at it', wip_limit: 1, external_artifacts: [],
    github_owner: 'example', cloud_sessions: 'no', executor_tool: 'claude-code', approve_from: 'sheet', owner_locale: 'en',
    hosting: 'later', deploy_target: 'none', domain: '', budget_monthly_usd: 0, risk_default: 'medium',
  });
  assert.ok(Object.values(r.resolved.answers).filter((v) => v.source === 'default').length === QUESTIONS.length - 1);
  assert.equal(JSON.parse(readFileSync(join(root, '.analucia', 'project.json'), 'utf8')).budget_monthly_usd, undefined, 'unknown budget: alerts off');
  assert.ok(r.resolved.notices.length >= QUESTIONS.length - 1, 'every default is said');
  // A known budget and a high default risk change the mechanisms.
  await runInit(root, { provided: { budget_monthly_usd: 120, risk_default: 'high', never_leaves: ['secrets/**', 'customer data'] }, locale: 'en', ...CONFIRM, out });
  assert.equal(JSON.parse(readFileSync(join(root, '.analucia', 'project.json'), 'utf8')).budget_monthly_usd, 120);
  const s = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'));
  assert.ok(s.permissions.ask.includes('Edit(//**)') && !s.permissions.allow.includes('Edit(/**)'), 'high: every edit asks');
  assert.ok(s.permissions.deny.includes('Read(secrets/**)') && s.permissions.deny.includes('Edit(secrets/**)'));
  assert.ok(!s.permissions.deny.some((r) => r.includes('customer data')), 'free text is recorded, not turned into a rule');
  const last = readLog(root).events.at(-1);
  assert.deepEqual(last.payload.changed, ['never_leaves', 'budget_monthly_usd', 'risk_default']);
});

test('adoption: a CLAUDE.md with foreign content keeps it and gains @AGENTS.md on top', async () => {
  const foreign = '# My project\n\nAlways run npm test before committing.\n';
  const root = project({ claude: foreign });
  writeFileSync(join(root, 'AGENTS.md'), '<!-- BEGIN:nextjs-agent-rules -->\nUse the App Router.\n<!-- END:nextjs-agent-rules -->\n');
  await runInit(root, { provided: esAnswers(), locale: 'es', ...CONFIRM, out });
  assert.equal(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), `@AGENTS.md\n\n${foreign}`);
  assert.ok(readFileSync(join(root, 'AGENTS.md'), 'utf8').startsWith('<!-- BEGIN:nextjs-agent-rules -->\nUse the App Router.\n<!-- END:nextjs-agent-rules -->\n'));
  await runInit(root, { provided: esAnswers(), locale: 'es', ...CONFIRM, out });
  assert.equal(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), `@AGENTS.md\n\n${foreign}`, 'added once');
});

test('the five catalogs have identical key sets; pt, zh-Hans and hi are marked not reviewed', () => {
  const load = (l) => JSON.parse(readFileSync(join(I18N, `${l}.json`), 'utf8'));
  const en = load('en');
  const keys = Object.keys(en.strings).sort();
  assert.deepEqual(LOCALES, ['en', 'pt', 'zh-Hans', 'hi', 'es']);
  for (const l of LOCALES) {
    const c = load(l);
    assert.deepEqual(Object.keys(c).sort(), ['reviewed', 'strings'], l);
    assert.deepEqual(Object.keys(c.strings).sort(), keys, l);
    for (const [k, v] of Object.entries(c.strings)) assert.ok(typeof v === 'string' && v.length, `${l}: ${k}`);
    assert.equal(c.reviewed, !['pt', 'zh-Hans', 'hi'].includes(l), `${l}.reviewed`);
  }
  for (const q of QUESTIONS) for (const k of [`q.${q.key}`, `h.${q.key}`]) assert.ok(keys.includes(k), k);
  for (const k of ['moment.1', 'moment.2', 'moment.3']) assert.ok(keys.includes(k));
  // Nothing user-facing is hard-coded in the interview: every quoted t('…') key exists in the catalog.
  const src = readFileSync(fileURLToPath(new URL('../lib/onboarding.mjs', import.meta.url)), 'utf8');
  for (const m of src.matchAll(/\bt\('([a-z_.]+)'/g)) assert.ok(keys.includes(m[1]), `catalog has ${m[1]}`);
});

test('no TTY: a real apply is refused (E_OWNER_TTY), and so is the interactive interview', () => {
  const root = project();
  const before = snapshot(root);
  const r = aos(root, ['init', '--answers', ES]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /aos init: E_OWNER_TTY /);
  const i = aos(root, ['init', '--locale', 'es']);
  assert.equal(i.status, 1);
  assert.match(i.stderr, /E_OWNER_TTY/);
  assert.deepEqual(snapshot(root), before);
});

test('the interview asks only what is missing or what the owner chooses to change, in the chosen language', async () => {
  const root = project();
  const asked = [];
  const scripted = (answers) => async (q) => { asked.push(q); return answers.shift() ?? ''; };
  const first = await interview(root, { locale: 'es', ask: scripted(['Tienda de prueba', 'yes']), out });
  assert.equal(first.purpose, 'Tienda de prueba');
  assert.equal(first.in_use, 'yes');
  assert.equal(asked.length, QUESTIONS.length, 'first run: every question once');
  assert.match(asked[0], /¿Para qué sirve, en una línea\?/);
  await runInit(root, { provided: first, locale: 'es', ...CONFIRM, out });
  asked.length = 0;
  const again = await interview(root, { locale: 'es', ask: scripted(['']), out });
  assert.deepEqual(again, {}, 'nothing to change: nothing asked except the change prompt');
  assert.equal(asked.length, 1);
  assert.match(asked[0], /¿Qué respuestas quieres cambiar\?/);
  asked.length = 0;
  const changed = await interview(root, { locale: 'es', ask: scripted(['wip_limit', '3']), out });
  assert.deepEqual(changed, { wip_limit: '3' });
  assert.match(asked[1], /¿Cuántos trabajos a la vez\?[\s\S]*Actual: 1\./);
  asked.length = 0;
  // A fresh project (with a GitHub remote, so github_owner has its default from the URL).
  const invalid = await interview(project(), { locale: 'en', ask: scripted(['', 'Shop', 'maybe', 'no']), out });
  assert.equal(invalid.purpose, 'Shop', 'an empty purpose is asked again');
  assert.equal(invalid.in_use, 'no', 'an invalid value is asked again');
});
