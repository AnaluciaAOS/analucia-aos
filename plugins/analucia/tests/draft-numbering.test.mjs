// ORD-0047 part 9 (AMD-0029, OBS-211): drafts are named by topic and get their number when they are placed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decisionMatches, dispatch } from '../lib/dispatch.mjs';
import { listDrafts, placeDrafts } from '../lib/drafts.mjs';
import { logPath, readLog } from '../lib/log.mjs';
import { replay } from '../lib/state.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = () => { const e = { ...process.env, GIT_TERMINAL_PROMPT: '0' }; delete e.CLAUDE_PROJECT_DIR; delete e.CLAUDE_CODE_SESSION_ID; return e; };
const aos = (root, args) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input: '', env: env() });

function project(code = 'DEMO') {
  const root = mkdtempSync(join(tmpdir(), 'aos-numbering-'));
  const a = join(root, '.analucia');
  for (const d of ['drafts', 'evidence', 'orders', 'verify']) mkdirSync(join(a, d), { recursive: true });
  writeFileSync(join(a, 'project.json'), `${JSON.stringify({ wip_limit: 1, locale: 'en', ...(code ? { project_code: code } : {}) })}\n`);
  writeFileSync(logPath(root), '');
  return root;
}
const orderText = (id, title, extra = []) => ['---', `id: ${id}`, `title: ${title}`, 'kind: fix', 'created: 2026-11-22', 'budget_max_minutes: 30', 'budget_max_attempts: 3', 'risk: low', 'cost_effect: none', ...extra, '---', '', `Evidence goes to .analucia/evidence/${id}/report.md on branch ord-${id}.`, '', '## Acceptance criteria', '', '- [ ] x', ''].join('\n');
const verifyText = (id) => `${JSON.stringify({ order: id, checks: [{ name: 'the check', run: 'exit 0', expect_exit: 0 }] }, null, 2)}\n`;
// A draft named by topic: `{id}` stands wherever the order needs its own ID.
function topicDraft(root, topic, { title = `Title of ${topic}`, extra = [] } = {}) {
  const d = join(root, '.analucia', 'drafts');
  writeFileSync(join(d, `draft-${topic}.md`), orderText('{id}', title, extra));
  writeFileSync(join(d, `draft-${topic}.json`), verifyText('{id}'));
  writeFileSync(join(d, `draft-${topic}.request.md`), '- a point of the request => the draft\n');
}
const events = (root) => readLog(root).events;
const read = (root, rel) => readFileSync(join(root, rel), 'utf8');
const draftFiles = (root, topics) => topics.flatMap((t) => ['md', 'json', 'request.md'].filter((f) => existsSync(join(root, '.analucia', 'drafts', `draft-${t}.${f}`)))).length;

test('two drafts placed in the other order get the numbers in the order placed, with {id} replaced everywhere', () => {
  const root = project();
  topicDraft(root, 'banner-search');
  topicDraft(root, 'export-sheet');
  const r = placeDrafts(root, { ids: ['draft-export-sheet', 'draft-banner-search'] });
  assert.deepEqual(r.refused, []);
  assert.deepEqual(r.placed, ['DEMO-0001', 'DEMO-0002'], 'the project code is used');
  assert.match(read(root, '.analucia/orders/DEMO-0001.md'), /title: Title of export-sheet/);
  assert.match(read(root, '.analucia/orders/DEMO-0002.md'), /title: Title of banner-search/);
  for (const id of r.placed) {
    assert.match(read(root, `.analucia/orders/${id}.md`), new RegExp(`^id: ${id}$`, 'm'));
    assert.match(read(root, `.analucia/orders/${id}.md`), new RegExp(`evidence/${id}/report.md on branch ord-${id}`));
    assert.equal(JSON.parse(read(root, `.analucia/verify/${id}.json`)).order, id);
    assert.doesNotMatch(read(root, `.analucia/orders/${id}.md`) + read(root, `.analucia/verify/${id}.json`), /\{id\}/);
  }
  assert.equal(draftFiles(root, ['export-sheet', 'banner-search']), 0, 'the drafts are removed');
  const logged = events(root).filter((e) => e.type === 'operation.logged' && e.payload?.operation === 'draft_numbered').map((e) => [e.payload.topic, e.payload.id]);
  assert.deepEqual(logged, [['export-sheet', 'DEMO-0001'], ['banner-search', 'DEMO-0002']], 'topic -> ID is recorded');
  assert.equal(replay(events(root)).orders['DEMO-0001'].state, 'queued');
});

test('a project without a code is numbered ORD-NNNN; the next free ID counts the orders already there', () => {
  const root = project(null);
  topicDraft(root, 'first');
  assert.deepEqual(placeDrafts(root, { ids: ['draft-first'] }).placed, ['ORD-0001']);
  topicDraft(root, 'second');
  assert.deepEqual(placeDrafts(root, { ids: ['draft-second'] }).placed, ['ORD-0002']);
});

test('aos drafts shows the ID a ready draft would get now, marked as not yet given', () => {
  const root = project();
  topicDraft(root, 'alpha');
  topicDraft(root, 'beta');
  const list = listDrafts(root);
  assert.deepEqual(list.map((d) => [d.id, d.ok, d.numbered, d.would_get]), [['draft-alpha', true, false, 'DEMO-0001'], ['draft-beta', true, false, 'DEMO-0002']]);
  const r = aos(root, ['drafts']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /draft-alpha/);
  assert.match(r.stdout, /would get the ID DEMO-0001 now \(not yet given/);
  assert.match(r.stdout, /would get the ID DEMO-0002 now/);
  assert.equal(draftFiles(root, ['alpha', 'beta']), 6, 'looking changes nothing');
});

test('a draft named by topic that carries a number in its id: is refused with the line that says how to name it', () => {
  const root = project();
  const d = join(root, '.analucia', 'drafts');
  writeFileSync(join(d, 'draft-numbered.md'), orderText('DEMO-0009', 'x'));
  writeFileSync(join(d, 'draft-numbered.json'), verifyText('{id}'));
  writeFileSync(join(d, 'draft-numbered.request.md'), '- a => b\n');
  const [one] = listDrafts(root);
  assert.equal(one.ok, false);
  assert.ok(one.problems.some((p) => /id: \{id\}/.test(p) && /by its topic/.test(p)), one.problems.join('\n'));
  assert.deepEqual(placeDrafts(root, { ids: ['draft-numbered'] }).placed, []);
  assert.equal(existsSync(join(root, '.analucia', 'orders', 'DEMO-0001.md')), false);
});

test('an old name keeps working: a draft named CODE-NNNN is placed as it is, with a warning', () => {
  const root = project();
  const d = join(root, '.analucia', 'drafts');
  writeFileSync(join(d, 'DEMO-0005.md'), orderText('DEMO-0005', 'old way'));
  writeFileSync(join(d, 'DEMO-0005.json'), verifyText('DEMO-0005'));
  writeFileSync(join(d, 'DEMO-0005.request.md'), '- a => b\n');
  const [one] = listDrafts(root);
  assert.equal(one.ok, true, one.problems.join('\n'));
  assert.match(one.warnings[0], /by its topic/);
  assert.match(aos(root, ['drafts']).stdout, /Warning: DEMO-0005 is named with a number/);
  assert.deepEqual(placeDrafts(root, { ids: ['DEMO-0005'] }).placed, ['DEMO-0005']);
  topicDraft(root, 'later');
  assert.deepEqual(placeDrafts(root, { ids: ['draft-later'] }).placed, ['DEMO-0006'], 'a topic draft takes the next free number after it');
});

test('a decision recorded by topic is linked to the ID at placement, and the dispatcher places the draft on it', () => {
  const root = project();
  const TEXT = 'Owner approved: do the sample order';
  topicDraft(root, 'sample', { extra: [`decision: ${TEXT}`] });
  assert.equal(dispatch(root, { dryRun: true }).stopped, 'owner', 'no decision yet: the owner decides');
  const rec = aos(root, ['decision', 'record', '--draft', 'sample', '--text', TEXT]);
  assert.equal(rec.status, 0, rec.stderr);
  assert.match(rec.stdout, /draft sample/);
  assert.equal(aos(root, ['decision', 'record', '--draft', 'Bad Topic', '--text', TEXT]).status, 2);
  const d = dispatch(root);
  assert.deepEqual(d.did[0].placed, ['DEMO-0001']);
  const linked = events(root).find((e) => e.type === 'decision.recorded' && e.subject === 'DEMO-0001');
  assert.ok(linked, 'the decision is linked to the new ID');
  assert.equal(linked.payload.draft, 'sample');
  assert.equal(decisionMatches(events(root), 'DEMO-0001', TEXT), true);
});
