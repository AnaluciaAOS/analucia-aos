// AMD-0006: the hosting question in aos init, the cost table and the own-server checklist.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { STALE_DAYS, hostingTable, loadOptions, vpsChecklist } from '../lib/hosting.mjs';
import { logPath, readLog } from '../lib/log.mjs';
import { LOCALES, catalog, runInit } from '../lib/onboarding.mjs';
import { validateProjectText } from '../lib/validate.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const ES = fileURLToPath(new URL('./fixtures/onboarding/answers-es.json', import.meta.url));
const env = { ...process.env };
delete env.CLAUDE_PROJECT_DIR;
const aos = (root, args) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input: '', env });
const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const CONFIRM = { isTTY: true, ask: async () => 'CONFIRM' };
const out = () => {};

function project() {
  const root = mkdtempSync(join(tmpdir(), 'aos-hosting-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'remote', 'add', 'origin', 'https://example@github.com/example/demo.git');
  mkdirSync(join(root, '.analucia'));
  writeFileSync(join(root, '.analucia', 'project.json'), '{"wip_limit":1}\n');
  writeFileSync(logPath(root), '');
  return root;
}
const answers = (extra = {}) => ({ ...JSON.parse(readFileSync(ES, 'utf8')).answers, ...extra });
const projectJson = (root) => JSON.parse(readFileSync(join(root, '.analucia', 'project.json'), 'utf8'));
const hostingEvents = (root) => readLog(root).events.filter((e) => e.type === 'hosting.chosen').map((e) => e.payload);

test('each answer is stored in project.json and appended as hosting.chosen; project.json stays valid', async () => {
  for (const [given, stored, payload] of [
    ['managed', { hosting: 'managed' }, { hosting: 'managed' }],
    ['own-server', { hosting: 'own-server' }, { hosting: 'own-server' }],
    ['already: a rented server the owner keeps', { hosting: 'already', hosting_where: 'a rented server the owner keeps' }, { hosting: 'already', where: 'a rented server the owner keeps' }],
  ]) {
    const root = project();
    await runInit(root, { provided: answers({ hosting: given }), locale: 'en', ...CONFIRM, out });
    const pj = projectJson(root);
    assert.deepEqual({ hosting: pj.hosting, ...(pj.hosting_where ? { hosting_where: pj.hosting_where } : {}) }, stored, given);
    assert.deepEqual(validateProjectText(readFileSync(join(root, '.analucia', 'project.json'), 'utf8')), [], given);
    assert.deepEqual(hostingEvents(root), [payload], given);
  }
});

test('later is accepted and is the default; already without a place and other words are refused', async () => {
  const root = project();
  await runInit(root, { provided: answers({ hosting: 'later' }), locale: 'en', ...CONFIRM, out });
  assert.equal(projectJson(root).hosting, 'later');
  const fresh = project();
  await runInit(fresh, { provided: answers(), locale: 'en', ...CONFIRM, out });
  assert.equal(projectJson(fresh).hosting, 'later', 'no answer: later');
  for (const bad of ['already', 'already:  ', 'cloud', 'the cheapest']) {
    await assert.rejects(runInit(project(), { provided: answers({ hosting: bad }), locale: 'en', ...CONFIRM, out }), (x) => x.code === 'E_ANSWER_VALUE', bad);
  }
  assert.ok(validateProjectText('{"hosting":"cheap"}\n').some((e) => e.code === 'E_FIELD_TYPE'));
  assert.ok(validateProjectText('{"hosting":"managed","hosting_where":"x"}\n').some((e) => e.code === 'E_FIELD_TYPE'), 'a place only with already');
});

test('aos init --hosting changes only that answer, records one event, and a second run changes nothing', async () => {
  const root = project();
  await runInit(root, { provided: answers(), locale: 'en', ...CONFIRM, out });
  const before = projectJson(root);
  const dry = aos(root, ['init', '--hosting', 'managed', '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /hosting: managed/);
  assert.equal(projectJson(root).hosting, 'later', 'a dry run writes nothing');
  const notTTY = aos(root, ['init', '--hosting', 'managed']);
  assert.match(notTTY.stderr, /E_OWNER_TTY/);
  await runInit(root, { provided: { hosting: 'own-server' }, locale: 'en', ...CONFIRM, out });
  assert.deepEqual(projectJson(root), { ...before, hosting: 'own-server' });
  assert.deepEqual(hostingEvents(root), [{ hosting: 'later' }, { hosting: 'own-server' }]);
  await runInit(root, { provided: { hosting: 'own-server' }, locale: 'en', ...CONFIRM, out });
  assert.equal(hostingEvents(root).length, 2, 'same answer: no new event');
});

test('every entry has checked_on, source, a kind, an operator and a USD range', () => {
  const options = loadOptions();
  assert.ok(options.length >= 2);
  for (const o of options) {
    assert.match(o.checked_on, /^\d{4}-\d{2}-\d{2}$/, o.name);
    assert.ok(!Number.isNaN(Date.parse(o.checked_on)), o.name);
    assert.match(o.source, /^https:\/\/\S+$/, o.name);
    assert.ok(['managed', 'own-server'].includes(o.kind), o.name);
    assert.equal(o.operated_by, o.kind === 'managed' ? 'platform' : 'owner', o.name);
    assert.ok(typeof o.monthly_usd.min === 'number' && (o.monthly_usd.max === null || o.monthly_usd.max >= o.monthly_usd.min), o.name);
    assert.ok(o.price_note, o.name);
  }
  for (const kind of ['managed', 'own-server']) assert.ok(options.filter((o) => o.kind === kind).length >= 2, kind);
});

test('the table is sorted by cost, always prints every date and the prices line, and warns on an entry older than 90 days', () => {
  const t = catalog('en');
  const options = [
    { name: 'B', kind: 'own-server', operated_by: 'owner', monthly_usd: { min: 9, max: 12 }, price_note: 'b', checked_on: '2026-01-01', source: 'https://b.example/pricing' },
    { name: 'A', kind: 'managed', operated_by: 'platform', monthly_usd: { min: 3, max: null }, price_note: 'a', checked_on: '2026-10-20', source: 'https://a.example/pricing' },
  ];
  const text = hostingTable(t, { now: new Date('2026-10-26T12:00:00Z'), options });
  const rows = text.split('\n').filter((l) => l.startsWith('  - '));
  assert.deepEqual(rows.map((r) => r.slice(4, 5)), ['A', 'B'], 'sorted by the low end of the range');
  assert.match(rows[0], /\$3\+ \(a\) \| the platform \| .* \| 2026-10-20 \| https:\/\/a\.example\/pricing$/);
  assert.match(rows[1], /\$9–\$12 \(b\) \| the owner \| .* \| 2026-01-01 \| https:\/\/b\.example\/pricing$/);
  assert.match(text, /^ {4}! checked 298 days ago: this price may be out of date\.$/m);
  assert.equal((text.match(/may be out of date/g) ?? []).length, 1, 'only the stale entry is warned');
  assert.match(text, /Prices change: check the source before you decide\.$/);
  const fresh = hostingTable(t, { now: new Date('2026-10-26T12:00:00Z'), options: [{ ...options[0], checked_on: '2026-07-28' }] });
  assert.doesNotMatch(fresh, /out of date/, `${STALE_DAYS} days is not yet stale`);
  for (const l of LOCALES) assert.match(hostingTable(catalog(l), { options }), /2026-10-20[\s\S]*2026-01-01/, l);
});

test('the output never says which option to pick; own-server adds the checklist, others do not', () => {
  const root = project();
  const file = join(root, 'answers.json');
  // One language field (ORD-0029 C): owner_locale sets the plan's language, so the answers say en.
  writeFileSync(file, JSON.stringify({ locale: 'en', answers: answers({ hosting: 'own-server', owner_locale: 'en' }) }));
  const r = aos(root, ['init', '--answers', file, '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  for (const o of loadOptions()) assert.ok(r.stdout.includes(`${o.checked_on} | ${o.source}`), o.name);
  assert.doesNotMatch(r.stdout, /\b(recommend\w*|best|cheapest|should (use|pick|choose)|we suggest|our pick|go with)\b/i);
  const items = vpsChecklist();
  assert.equal(items.length, 6);
  for (const i of items) assert.ok(r.stdout.includes(`[ ] ${i}`), i);
  assert.match(r.stdout, /Analucia never touches any server\./);
  writeFileSync(file, JSON.stringify({ locale: 'en', answers: answers({ hosting: 'managed', owner_locale: 'en' }) }));
  assert.doesNotMatch(aos(root, ['init', '--answers', file, '--dry-run']).stdout, /VPS-CHECKLIST/);
});
