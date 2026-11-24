// ORD-0042 part 10 (OBS-154): a business rule is confirmed before it is written. An order has the fixed section
// `## Business rules`: one rule per list item, each with one example with numbers; an order with none writes the
// single item `- none`. `aos drafts` checks the shape (an item with no digit is not ready; a draft of kind build
// without the section is not ready). When `aos sign` shows a draft to place it prints every business rule before
// the typed confirmation, and the placement records them in the decision.recorded event. No extra step.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { businessRulesOf, listDrafts } from '../lib/drafts.mjs';
import { logPath, readLog } from '../lib/log.mjs';
import { sign } from '../lib/sign.mjs';
import { validateOrderText } from '../lib/validate.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env };
delete env.CLAUDE_PROJECT_DIR;
delete env.CLAUDE_CODE_SESSION_ID;
const aos = (root, args) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input: '', env });
const RULES = ['- For a cost of 8 and a reference price of 20 the price is 22: the reference price plus 10 %.', '- A price never ends below cost plus 25 %: for a cost of 8 the lowest price is 10.'];
const order = (id, { kind = 'build', rules, extra = [] } = {}) => ['---', `id: ${id}`, `title: Title of ${id}`, `kind: ${kind}`, 'created: 2026-11-16', 'budget_max_minutes: 30', 'budget_max_attempts: 2', 'risk: low', 'cost_effect: none', ...(kind === 'build' ? ['replaces: []'] : []), ...extra, '---', '', 'Work.', '', ...(rules === undefined ? [] : ['## Business rules', '', ...rules, '']), '## Acceptance criteria', '', '- [ ] x', ''].join('\n');
const verifyFile = (id) => `${JSON.stringify({ order: id, checks: [{ name: 'c', run: 'exit 0', expect_exit: 0 }] })}\n`;

function project() {
  const root = mkdtempSync(join(tmpdir(), 'aos-rules-'));
  for (const d of ['orders', 'verify', 'drafts']) mkdirSync(join(root, '.analucia', d), { recursive: true });
  writeFileSync(join(root, '.analucia', 'project.json'), '{"wip_limit":1,"locale":"en"}\n');
  writeFileSync(logPath(root), '');
  return root;
}
const draft = (root, id, text) => {
  writeFileSync(join(root, '.analucia', 'drafts', `${id}.md`), text);
  writeFileSync(join(root, '.analucia', 'drafts', `${id}.request.md`), '- a point of the request => the draft'), writeFileSync(join(root, '.analucia', 'drafts', `${id}.json`), verifyFile(id));
};
const owner = (answers) => {
  const lines = [];
  const prompts = [];
  return { isTTY: true, push: false, lines, prompts, out: (s) => lines.push(s), ask: async (q) => { prompts.push({ q, seen: lines.join('\n') }); return answers.length ? answers.shift() : ''; } };
};

test('the section: one rule per list item, read with its example; - none says there is none', () => {
  assert.deepEqual(businessRulesOf(order('ORD-0001', { rules: RULES })), RULES.map((r) => r.slice(2)));
  assert.deepEqual(businessRulesOf(order('ORD-0001', { rules: ['- none'] })), []);
  assert.deepEqual(businessRulesOf(order('ORD-0001', { rules: ['- None.'] })), []);
  assert.equal(businessRulesOf(order('ORD-0001')), undefined, 'no section');
  // An item may run over several lines; the section ends at the next heading.
  assert.deepEqual(businessRulesOf(order('ORD-0001', { rules: ['- For a cost of 8', '  the price is 22.', '* A second rule: 3 for 2.'] })), ['For a cost of 8 the price is 22.', 'A second rule: 3 for 2.']);
  // aos validate asks for nothing: a placed order never needs the section.
  assert.deepEqual(validateOrderText(order('ORD-0001'), 'ORD-0001.md', { pinned: true }), []);
  assert.deepEqual(validateOrderText(order('ORD-0001', { rules: RULES }), 'ORD-0001.md', { pinned: true }), []);
});

test('aos drafts checks the shape: an item with no example with numbers, or a build draft without the section, is not ready', () => {
  const root = project();
  draft(root, 'ORD-0001', order('ORD-0001'));
  assert.match(listDrafts(root)[0].problems.join('\n'), /E_MISSING_FIELD .*build.* has no section "## Business rules": list each rule with one example with numbers, or write the single item "- none"/);
  draft(root, 'ORD-0001', order('ORD-0001', { rules: [RULES[0], '- The price follows the season.'] }));
  const d = listDrafts(root)[0];
  assert.equal(d.ok, false);
  assert.match(d.problems.join('\n'), /E_FIELD_TYPE .*business rule 2 \("The price follows the season\."\) has no example with numbers/);
  assert.equal(aos(root, ['drafts']).status, 1);
  draft(root, 'ORD-0001', order('ORD-0001', { rules: ['- none', RULES[0]] }));
  assert.match(listDrafts(root)[0].problems.join('\n'), /"- none" is the only item of the section when there is no rule/);
  for (const rules of [RULES, ['- none']]) {
    draft(root, 'ORD-0001', order('ORD-0001', { rules }));
    assert.deepEqual(listDrafts(root)[0].problems, [], JSON.stringify(rules));
  }
  assert.deepEqual(listDrafts(root)[0].rules, []);
  // Another kind is not asked for the section, but a section it has is checked the same way.
  draft(root, 'ORD-0001', order('ORD-0001', { kind: 'fix' }));
  assert.deepEqual(listDrafts(root)[0].problems, []);
  draft(root, 'ORD-0001', order('ORD-0001', { kind: 'fix', rules: ['- No numbers here.'] }));
  assert.equal(listDrafts(root)[0].ok, false);
});

test('aos sign prints every business rule of a draft before the typed confirmation, and the placement records them with the decision', async () => {
  const root = project();
  draft(root, 'ORD-0001', order('ORD-0001', { rules: RULES, extra: ['decision: Price the summer stock from the reference price'] }));
  const o = owner(['PLACE']);
  const r = await sign(root, o);
  assert.deepEqual(r.placed, ['ORD-0001']);
  // Shown before the word is asked, with their examples.
  assert.equal(o.prompts.length, 1);
  assert.match(o.prompts[0].q, /^Type PLACE/);
  assert.match(o.prompts[0].seen, /Business rules of ORD-0001 that you confirm by placing it \(2\):/);
  for (const rule of RULES) assert.ok(o.prompts[0].seen.includes(rule.slice(2)), rule);
  // Recorded in the decision.recorded event of the placement: no extra step, no extra question.
  const decision = readLog(root).events.find((e) => e.type === 'decision.recorded');
  assert.deepEqual([decision.actor, decision.subject], ['owner', 'ORD-0001']);
  assert.equal(decision.payload.text, 'Price the summer stock from the reference price');
  assert.deepEqual(decision.payload.business_rules, RULES.map((x) => x.slice(2)));
  assert.equal(aos(root, ['validate']).status, 0);
  assert.equal(aos(root, ['verify-log']).status, 0);
});

test('rules without a decision line are still recorded; a draft with none shows and records no rule; not confirmed, nothing is recorded', async () => {
  const root = project();
  draft(root, 'ORD-0001', order('ORD-0001', { rules: RULES }));
  const refused = owner(['no']);
  await sign(root, refused);
  assert.match(refused.prompts[0].seen, /Business rules of ORD-0001/);
  assert.equal(readLog(root).events.length, 0, 'not confirmed: nothing recorded');
  await sign(root, owner(['PLACE']));
  const d = readLog(root).events.find((e) => e.type === 'decision.recorded');
  assert.deepEqual(d.payload.business_rules, RULES.map((x) => x.slice(2)));
  assert.match(d.payload.text, /Title of ORD-0001/, 'without a decision line the title of the order stands for it');
  const none = project();
  draft(none, 'ORD-0001', order('ORD-0001', { rules: ['- none'] }));
  const o = owner(['PLACE']);
  await sign(none, o);
  assert.doesNotMatch(o.prompts[0].seen, /Business rules of/);
  assert.equal(readLog(none).events.some((e) => e.type === 'decision.recorded'), false);
});

test('the director entrypoint says where a rule of the business enters an order', () => {
  const entry = readFileSync(fileURLToPath(new URL('../templates/director-entry.md', import.meta.url)), 'utf8');
  const line = entry.split('\n').find((l) => /## Business rules/.test(l) && /example/.test(l));
  assert.ok(line);
  assert.match(line, /not a rule until/);
});
