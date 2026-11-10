// ORD-0029 C: the 15-question wizard of aos init. Closed questions, numbers, back, a summary, one language field.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { logPath } from '../lib/log.mjs';
import { LOCALES, QUESTIONS, catalog, runInit } from '../lib/onboarding.mjs';
import { TOTAL, WIZARD, wizard } from '../lib/wizard.mjs';

const I18N = fileURLToPath(new URL('../i18n/', import.meta.url));
const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
function project() {
  const root = mkdtempSync(join(tmpdir(), 'aos-wiz-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'remote', 'add', 'origin', 'https://example@github.com/example/demo.git');
  mkdirSync(join(root, '.analucia'));
  writeFileSync(join(root, '.analucia', 'project.json'), '{"wip_limit":1,"deploy":{"policy":"batch"}}\n');
  writeFileSync(logPath(root), '');
  return root;
}
// The owner, typing the given lines; every prompt and every printed text is kept.
function owner(lines) {
  const prompts = [];
  const printed = [];
  return { prompts, printed, ask: async (q) => { prompts.push(q); return lines.length ? lines.shift() : ''; }, out: (s) => printed.push(s) };
}
// One answer per question (option numbers), then Enter at the summary.
const ALL_FIRST = Array(TOTAL).fill('1');

test('15 closed questions in 3 blocks of 5, each with numbered options and "Question N of 15" with a block progress line', async () => {
  assert.equal(WIZARD.length, 15);
  for (const b of ['security', 'operation', 'environment']) assert.equal(WIZARD.filter((q) => q.block === b).length, 5, b);
  assert.deepEqual(WIZARD.map((q) => q.block), [...Array(5).fill('security'), ...Array(5).fill('operation'), ...Array(5).fill('environment')]);
  for (const q of WIZARD) assert.ok(QUESTIONS.some((x) => x.key === q.key), `${q.key} is an answer key of onboarding.json`);
  const o = owner([...ALL_FIRST, '']);
  await wizard(project(), { locale: 'en', ask: o.ask, out: o.out });
  for (let n = 1; n <= 15; n++) assert.match(o.prompts[n - 1], new RegExp(`^\\nQuestion ${n} of 15 · `), `question ${n}`);
  assert.match(o.prompts[0], /Security □□□□□ 0 of 5 · 0% done · about 5 min left\n/);
  assert.match(o.prompts[6], /Operation ■□□□□ 1 of 5 · 40% done/);
  assert.match(o.prompts[14], /Environment ■■■■□ 4 of 5 · 93% done · about 1 min left/);
  assert.match(o.prompts[0], /\n {2}1\. No\n {2}2\. Yes\n {2}3\. Not sure\n> $/);
  assert.match(o.printed[0], /15 questions in 3 blocks of 5/);
});

test('0 goes back and lets the owner change an answer; a wrong number is asked again', async () => {
  const o = owner(['2', '0', '3', '9', '1', ...Array(13).fill('1'), '']);
  const { provided } = await wizard(project(), { locale: 'en', ask: o.ask, out: o.out });
  assert.equal(provided.end_user_input, 'unsure', 'the first answer was changed after going back');
  assert.match(o.prompts[1], /^\nQuestion 2 of 15/);
  assert.match(o.prompts[2], /^\nQuestion 1 of 15[\s\S]*Current answer: Yes/);
  assert.ok(o.printed.includes('Type a number from 1 to 5, or 0 to go back.'), 'the 9 was refused');
  const first = owner(['0', ...ALL_FIRST, '']);
  await wizard(project(), { locale: 'en', ask: first.ask, out: first.out });
  assert.ok(first.printed.includes('This is the first question; there is nothing to go back to.'));
});

test('the summary lists the 15 answers and any of them can be changed before the plan', async () => {
  const o = owner([...ALL_FIRST, '9', '3', '']);
  const { provided } = await wizard(project(), { locale: 'en', ask: o.ask, out: o.out });
  const summary = o.prompts.find((p) => p.includes('Your answers:'));
  for (let n = 1; n <= 15; n++) assert.match(summary, new RegExp(`\\n {2}${n}\\. `), `summary line ${n}`);
  assert.match(summary, /9\. How many tasks may the assistant work on at the same time\? → One at a time/);
  assert.equal(provided.wip_limit, 3);
  assert.equal(o.prompts.filter((p) => p.includes('Your answers:')).length, 2, 'the summary is shown again after the change');
});

test('the language question switches every later text, the plan and the CONFIRM prompt; no hosting table in the wizard', async () => {
  const root = project();
  // Questions 1–10: first option; 11: Español; 12–15: first option; the purpose is the first option ("a website").
  const o = owner([...Array(10).fill('1'), '2', ...Array(4).fill('1'), '']);
  const { provided } = await wizard(root, { locale: 'en', ask: o.ask, out: o.out });
  assert.equal(provided.owner_locale, 'es');
  assert.match(o.prompts[10], /^\nQuestion 11 of 15/);
  assert.match(o.prompts[11], /^\nPregunta 12 de 15 · Entorno/);
  assert.match(o.prompts.at(-1), /Tus respuestas:/);
  const asked = [];
  const printed = [];
  await runInit(root, { provided, locale: 'en', isTTY: true, ask: async (q) => { asked.push(q); return 'CONFIRM'; }, out: (s) => printed.push(s), wizard: true });
  const plan = printed.join('\n');
  assert.match(plan, /^Plan de arranque/);
  assert.equal(asked[0].trim(), catalog('es')('plan.confirm').trim());
  assert.doesNotMatch(plan, new RegExp(catalog('es')('hosting.title').replace(/[()]/g, '\\$&')));
  assert.doesNotMatch(plan, /USD|\$\d/, 'no price table');
  const pj = JSON.parse(readFileSync(join(root, '.analucia', 'project.json'), 'utf8'));
  assert.equal(pj.locale, 'es');
  const onb = JSON.parse(readFileSync(join(root, '.analucia', 'onboarding.json'), 'utf8'));
  assert.equal(onb.locale, 'es', 'one language field: onboarding.json and project.json agree');
  assert.equal(onb.answers.owner_locale.value, 'es');
  assert.equal(onb.answers.purpose.value, 'a website');
});

test('earlier onboarding.json: Enter keeps every answer, and the questions the wizard does not ask keep theirs', async () => {
  const root = project();
  const es = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/onboarding/answers-es.json', import.meta.url)), 'utf8')).answers;
  await runInit(root, { provided: { ...es, domain: 'example.test', external_artifacts: ['docs/old.md'] }, locale: 'es', isTTY: true, ask: async () => 'CONFIRM', out: () => {} });
  const before = readFileSync(join(root, '.analucia', 'onboarding.json'), 'utf8');
  const o = owner([]); // Enter everywhere
  const { provided } = await wizard(root, { locale: 'en', ask: o.ask, out: o.out });
  assert.deepEqual(provided, {}, 'nothing changed');
  assert.match(o.prompts[0], /^\nPregunta 1 de 15/, 'the earlier language answer is used from the first question');
  assert.match(o.prompts[5], /Respuesta actual: Analucia AOS: el sistema/, 'a free-text answer of an earlier file is shown and kept');
  await runInit(root, { provided, locale: 'en', isTTY: true, ask: async () => 'CONFIRM', out: () => {}, wizard: true });
  const after = JSON.parse(readFileSync(join(root, '.analucia', 'onboarding.json'), 'utf8'));
  assert.equal(JSON.stringify(after), JSON.stringify(JSON.parse(before)), 'onboarding.json is unchanged');
  assert.equal(after.answers.domain.value, 'example.test');
});

test('an answers file may name the language as locale or language: it is the same one field', async () => {
  for (const alias of ['locale', 'language']) {
    const root = project();
    const es = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/onboarding/answers-es.json', import.meta.url)), 'utf8')).answers;
    delete es.owner_locale;
    const printed = [];
    await runInit(root, { provided: { ...es, [alias]: 'pt' }, locale: 'en', dryRun: true, out: (s) => printed.push(s) });
    assert.match(printed[0], new RegExp(`^${catalog('pt')('plan.title')}`), alias);
  }
});

test('the wizard texts exist in every catalog and use no project jargon', () => {
  const load = (l) => JSON.parse(readFileSync(join(I18N, `${l}.json`), 'utf8')).strings;
  const en = load('en');
  const keys = Object.keys(en).filter((k) => k.startsWith('w.'));
  for (let i = 0; i < 15; i++) {
    assert.ok(keys.includes(`w.q.${i + 1}`));
    WIZARD[i].options.forEach((_, n) => assert.ok(keys.includes(`w.o.${i + 1}.${n + 1}`), `w.o.${i + 1}.${n + 1}`));
  }
  for (const l of LOCALES) for (const k of keys) assert.ok(load(l)[k], `${l} ${k}`);
  const JARGON = /\b(?:wip|enum|deploy\w*|hook|origin|CLI|SSH|repo|locale|owner_locale|onboarding|executor|director|order|unknown|stdin|TTY)\b/i;
  for (const k of keys) assert.doesNotMatch(en[k], JARGON, k);
});
