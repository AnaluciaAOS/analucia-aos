// ORD-0047 part 4 (OBS-206): `aos text has|lacks` is safe with accents; a verify file with grep over non-ASCII text is refused.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GREP_NON_ASCII_RE, closedIn, validateVerifyText } from '../lib/validate.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'aos-text-'));
const file = join(dir, 'doc.txt');
writeFileSync(file, 'Acción del año\r\nSeñor Pérez\r\nहिंदी पाठ\r\nPlain Words\r\n');
const text = (...args) => spawnSync(process.execPath, [AOS, 'text', ...args], { encoding: 'utf8' });

test('has and lacks answer on tildes, ñ and Hindi, with and without -i', () => {
  assert.equal(text('has', file, 'Acción').status, 0);
  assert.equal(text('has', file, 'año').status, 0);
  assert.equal(text('has', file, 'Señor').status, 0);
  assert.equal(text('has', file, 'हिंदी').status, 0);
  assert.equal(text('has', file, 'acción').status, 1);
  assert.equal(text('has', file, 'acción', '-i').status, 0);
  assert.equal(text('has', file, 'plain words', '-i').status, 0);
  assert.equal(text('lacks', file, 'Acción').status, 1);
  assert.equal(text('lacks', file, 'camión').status, 0);
  const miss = text('has', join(dir, 'none.txt'), 'x');
  assert.equal(miss.status, 1);
  assert.match(miss.stdout, /does not exist/);
  assert.equal(text('has', file).status, 2);
});

test('a decomposed accent (e + combining mark) equals the composed one', () => {
  writeFileSync(join(dir, 'nfd.txt'), 'Acción y mas\n');
  assert.equal(text('has', join(dir, 'nfd.txt'), 'Acción').status, 0);
});

const verify = (run) => `${JSON.stringify({ order: 'ORD-0001', checks: [{ name: 'c', run, expect_exit: 0 }] })}\n`;
test('aos validate refuses grep with a non-ASCII pattern and names the aos text line to use', () => {
  const bad = validateVerifyText(verify("grep -q 'acción' report.md"), 'ORD-0001.json', { grepAscii: true });
  assert.equal(bad.length, 1);
  assert.equal(bad[0].code, 'E_GREP_NON_ASCII');
  assert.match(bad[0].message, /aos text has <file> "<text>"/);
  assert.equal(validateVerifyText(verify("grep -q 'action' report.md"), 'ORD-0001.json', { grepAscii: true }).length, 0);
  assert.equal(validateVerifyText(verify("node aos.mjs text has report.md 'acción'"), 'ORD-0001.json', { grepAscii: true }).length, 0);
  assert.equal(validateVerifyText(verify("cat x | grep -ci 'año'"), 'ORD-0001.json', { grepAscii: true })[0].code, 'E_GREP_NON_ASCII');
  // without the option (a closed order) nothing is judged
  assert.equal(validateVerifyText(verify("grep -q 'acción' report.md"), 'ORD-0001.json').length, 0);
  assert.ok(GREP_NON_ASCII_RE.test("grep 'é' f"));
});

test('the verify files of closed orders are not affected', () => {
  const closed = [{ type: 'order.state_changed', subject: 'ORD-0001', payload: { from: 'verified', to: 'closed' } }];
  assert.equal(closedIn(closed, 'ORD-0001'), true);
  assert.equal(closedIn(closed, 'ORD-0002'), false);
});
