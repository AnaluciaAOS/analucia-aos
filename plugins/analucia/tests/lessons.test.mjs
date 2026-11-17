// ORD-0041 part 9: three lessons written where a director and an executor will read them (the director entrypoint,
// the rules block, one template), with no new command: a data file of the owner has one writer and is never
// overwritten without comparing first; an expected value says which rule must produce it, and its unit; a control
// calls the function it controls.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BEGIN, END, blockTemplate } from '../lib/guards.mjs';

const read = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const LESSONS = [
  ['one writer', /one writer/i, /compar/i],
  ['the rule and the unit of an expected value', /expected value/i, /rule/i, /unit/i],
  ['a control calls the function it controls', /control/i, /same function/i],
];

test('the three lessons are in the director entrypoint, in the rules block and in the template', () => {
  for (const [where, text] of [['director entrypoint', read('templates/director-entry.md')], ['rules block', blockTemplate()], ['template', read('templates/owner-data-file.md')]]) {
    for (const [name, ...patterns] of LESSONS) {
      // In the entrypoint and the block each lesson is one line; the template spreads it over its sections.
      const unit = where === 'template' ? [text] : text.split('\n');
      assert.ok(unit.some((u) => patterns.every((p) => p.test(u))), `${where}: ${name}`);
    }
  }
});

test('the template says what each number means, where it comes from and its unit, and the rules block still fits', () => {
  const template = read('templates/owner-data-file.md');
  for (const part of ['What it means', 'Where it comes from', 'Unit', 'The rule expected to win', 'never edits the file']) assert.ok(template.includes(part), part);
  assert.ok(Buffer.byteLength(`${BEGIN}\n${blockTemplate()}${END}`, 'utf8') <= 8192);
  assert.match(read('docs/INDEX.md'), /owner-data-file\.md/);
});
