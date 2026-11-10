import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const AOS = join(here, '..', 'bin', 'aos.mjs');
const FIX = join(here, 'fixtures');
const REPO = join(here, '..', '..', '..');

const aos = (...args) => {
  const r = spawnSync(process.execPath, [AOS, ...args], { encoding: 'utf8' });
  // First lines only; the indented second line is the "next (<who>)" hint (SPEC-0003 §2).
  const codes = [...new Set(r.stdout.split('\n').filter((l) => l && !l.startsWith(' ')).map((l) => l.split(' ')[1]))];
  return { status: r.status, stdout: r.stdout, codes };
};

test('valid fixture tree passes', () => {
  const r = aos('validate', join(FIX, 'valid'));
  assert.equal(r.stdout, '');
  assert.equal(r.status, 0);
});

const invalid = readdirSync(join(FIX, 'invalid')).sort();
for (const code of invalid) {
  test(`invalid fixture ${code} fails with exactly ${code}`, () => {
    const dir = join(FIX, 'invalid', code);
    const target = existsSync(join(dir, '.analucia')) ? dir : join(dir, readdirSync(dir)[0]);
    const r = aos('validate', target);
    assert.equal(r.status, 1, r.stdout);
    assert.deepEqual(r.codes, [code], r.stdout);
    assert.match(r.stdout, new RegExp(`^[^\\n]+:\\d+: ${code} `));
  });
}

test('every error code emitted by the validator has a failing fixture', () => {
  const src = readFileSync(join(here, '..', 'lib', 'validate.mjs'), 'utf8');
  const emitted = [...new Set(src.match(/'E_[A-Z_]+'/g).map((s) => s.slice(1, -1)))].sort();
  assert.deepEqual(emitted.filter((c) => !invalid.includes(c)), []);
  assert.deepEqual(invalid.filter((c) => !emitted.includes(c)), []);
});

// ORD-0033 A.1: a public checkout carries no .analucia of this repository (release manifest, private list). These
// two tests then skip and name the missing path; when the files are present they run as before.
const missing = (...rels) => rels.filter((r) => !existsSync(join(REPO, r)));
const skipWithout = (...rels) => {
  const gone = missing(...rels);
  return gone.length ? `not in this checkout: ${gone.join(', ')} (private to the source repository; a public checkout has none)` : false;
};

test('the real orders in .analucia/orders pass', { skip: skipWithout('.analucia/orders') }, () => {
  const dir = join(REPO, '.analucia', 'orders');
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  assert.ok(files.length >= 3);
  for (const f of files) {
    const r = aos('validate', join(dir, f));
    assert.equal(r.status, 0, `${f}: ${r.stdout}`);
  }
});

test('the repository validates', { skip: skipWithout('.analucia/project.json', '.analucia/events.jsonl') }, () => {
  const r = aos('validate', REPO);
  assert.equal(r.status, 0, r.stdout);
});
