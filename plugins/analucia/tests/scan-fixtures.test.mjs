// ORD-0043 (AMD-0017 item 4): scripts/scan-fixtures.mjs counts scan category 5 without the hits inside declared fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'scan-fixtures.mjs');
const skip = !existsSync(SCRIPT);
const { declaredFixtures, countAfterFixtures, categoryLine } = skip ? {} : await import(pathToFileURL(SCRIPT).href);

const scan = (paths) => ({ result: { account: { distinct: paths.length, locations: paths.map((path, i) => ({ rule: 'r', path, line: i + 1 })) } } });

test('scan-fixtures: the declared file is read with its reason and comments', { skip }, () => {
  const d = declaredFixtures('# comment\n\na/b.test.mjs  # why\nc/d.mjs\n');
  assert.deepEqual([...d], ['a/b.test.mjs', 'c/d.mjs']);
});

test('scan-fixtures: hits inside a declared file are left out, others stay', { skip }, () => {
  const d = new Set(['a/b.test.mjs']);
  assert.deepEqual(countAfterFixtures(scan(['a/b.test.mjs', 'a/b.test.mjs']).result.account, d), { raw: 2, after: 0 });
  assert.deepEqual(countAfterFixtures(scan(['a/b.test.mjs', 'x/y.mjs']).result.account, d), { raw: 2, after: 1 });
  assert.equal(categoryLine(scan(['a/b.test.mjs']), d), 'Scan category 5: 0 after declared fixtures (raw 1)');
});

test('scan-fixtures: the repository declares exactly the push account test, and the command prints the line without a name', { skip }, () => {
  const d = declaredFixtures(readFileSync(join(ROOT, 'scripts', 'release-fixtures.txt'), 'utf8'));
  assert.deepEqual([...d], ['plugins/analucia/tests/push-account.test.mjs']);
  const f = join(mkdtempSync(join(tmpdir(), 'scanfix-')), 'scan.json');
  writeFileSync(f, JSON.stringify(scan(['plugins/analucia/tests/push-account.test.mjs', 'other.mjs'])));
  const r = spawnSync(process.execPath, [SCRIPT, f], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'Scan category 5: 1 after declared fixtures (raw 2)');
});

test('scan-fixtures: no argument is a usage error', { skip }, () => {
  assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 2);
});
