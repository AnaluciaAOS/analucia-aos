// ORD-0047 part 13 (OBS-191): `aos admit` and `aos drafts` run the release guard's matcher on the order, its verify
// file, its rollback plan and its request file, tracked by git or not, naming file and line, never the word.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { listDrafts } from '../lib/drafts.mjs';
import { scanFiles } from '../lib/denylist.mjs';
import { hashLF } from '../lib/lock.mjs';
import { admit } from '../lib/lifecycle.mjs';
import { logPath } from '../lib/log.mjs';

const WORD = 'zorblaxq'; // made up
const order = (id, extra = '') => ['---', `id: ${id}`, 'title: T', 'kind: fix', 'created: 2026-11-23', 'budget_max_minutes: 30', 'budget_max_attempts: 3', 'risk: low', 'cost_effect: none', '---', '', `Evidence goes to .analucia/evidence/${id}/report.md.`, extra, '', '## Acceptance criteria', '', '- [ ] x', ''].join('\n');
const verify = (id, run = 'exit 0') => `${JSON.stringify({ order: id, checks: [{ name: 'c', run, expect_exit: 0 }] })}\n`;

function project(listed = true) {
  const root = mkdtempSync(join(tmpdir(), 'aos-deny-order-'));
  const list = join(mkdtempSync(join(tmpdir(), 'aos-deny-order-list-')), 'list.txt');
  writeFileSync(list, `# a comment\n${WORD}\n`);
  const a = join(root, '.analucia');
  for (const d of ['drafts', 'evidence', 'orders', 'verify', 'rollback']) mkdirSync(join(a, d), { recursive: true });
  writeFileSync(join(a, 'project.json'), `${JSON.stringify({ wip_limit: 1, locale: 'en', ...(listed ? { release_denylist: list } : {}) })}\n`);
  writeFileSync(logPath(root), '');
  return root;
}
function placed(root, id, { orderExtra = '', verifyRun } = {}) {
  const o = order(id, orderExtra);
  const v = verify(id, verifyRun);
  writeFileSync(join(root, '.analucia', 'orders', `${id}.md`), o);
  writeFileSync(join(root, '.analucia', 'verify', `${id}.json`), v);
  const files = { [`.analucia/orders/${id}.md`]: hashLF(Buffer.from(o)), [`.analucia/verify/${id}.json`]: hashLF(Buffer.from(v)) };
  writeFileSync(join(root, '.analucia', 'director.lock'), `${JSON.stringify({ files })}\n`);
}
const refusal = (fn) => { try { fn(); } catch (e) { return e; } return null; };

test('scanFiles names the file and line of each hit, never the word; a missing file is skipped', () => {
  const root = project();
  writeFileSync(join(root, 'a.md'), `fine\nsee ${WORD.toUpperCase()} here\n`);
  assert.ok(scanFiles(root, { release_denylist: join(root, 'nope.txt') }, ['a.md']).missing, 'a list that cannot be read fails closed');
  const listPath = JSON.parse(readFileSync(join(root, '.analucia', 'project.json'), 'utf8')).release_denylist;
  const hit = scanFiles(root, { release_denylist: listPath }, ['a.md', 'gone.md']);
  assert.deepEqual(hit.hits, ['a.md:2 (rule 1)']);
  assert.ok(!JSON.stringify(hit).toLowerCase().includes(WORD));
  assert.deepEqual(scanFiles(root, {}, ['a.md']).hits, [], 'no key, no check');
});

test('aos admit refuses a forbidden name in the order, its verify file, its rollback plan or its request file, none of them in git', () => {
  for (const where of ['order', 'verify', 'rollback', 'request']) {
    const root = project();
    const id = 'ORD-0002';
    placed(root, id, { orderExtra: where === 'order' ? `a line with ${WORD}` : '', verifyRun: where === 'verify' ? `echo ${WORD}` : undefined });
    if (where === 'rollback') writeFileSync(join(root, '.analucia', 'rollback', `${id}.md`), `\nundo ${WORD}\n`);
    if (where === 'request') writeFileSync(join(root, '.analucia', 'drafts', `${id}.request.md`), `- a point => ${WORD}\n`);
    const e = refusal(() => admit(root, id));
    assert.equal(e?.code, 'E_DENYLIST_FILE', `${where}: ${e?.message}`);
    assert.ok(!e.message.toLowerCase().includes(WORD), 'the word is never printed');
    assert.match(e.message, /:\d+ \(rule 1\)/);
  }
});

test('aos admit passes clean files; with no release_denylist key nothing is checked', () => {
  const clean = project();
  placed(clean, 'ORD-0002');
  assert.equal(refusal(() => admit(clean, 'ORD-0002')), null);
  const nokey = project(false);
  placed(nokey, 'ORD-0002', { orderExtra: `has ${WORD}` });
  assert.equal(refusal(() => admit(nokey, 'ORD-0002')), null);
});

test('aos drafts refuses a draft with a forbidden name in its order, verify or request file', () => {
  const root = project();
  const d = join(root, '.analucia', 'drafts');
  writeFileSync(join(d, 'ORD-0002.md'), order('ORD-0002'));
  writeFileSync(join(d, 'ORD-0002.json'), verify('ORD-0002'));
  writeFileSync(join(d, 'ORD-0002.request.md'), `- ask ${WORD} => the draft\n`);
  const [draft] = listDrafts(root);
  const p = draft.problems.find((x) => x.startsWith('E_DENYLIST_FILE'));
  assert.ok(p, JSON.stringify(draft.problems));
  assert.match(p, /ORD-0002\.request\.md:1 \(rule 1\)/);
  assert.ok(!p.toLowerCase().includes(WORD));
});
