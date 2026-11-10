// ORD-0026 run 2: the release guard skips the content of binary files (a term matched by chance inside a PNG) and
// still reports every text match, file-name match and whole-word rule exactly as before.
// ORD-0026 run 3: the output never repeats a term, a matched line or a file name containing a term (path and line and
// rule position only; such a file by its position in `git ls-files`), and generated verify reports are path only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GUARD = fileURLToPath(new URL('../../../scripts/release-guard.mjs', import.meta.url));
const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' });
// A made-up term, so the test never repeats a real denylisted word.
const TERM = 'zorblaxq';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);

// A git repository whose tracked files are `files` ({ path: string | Buffer }), plus a denylist outside it.
function repo(files, denylist = `${TERM}\n`) {
  const root = mkdtempSync(join(tmpdir(), 'aos-guard-'));
  git(root, 'init', '-q');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  git(root, 'add', '-A');
  const list = join(mkdtempSync(join(tmpdir(), 'aos-guard-list-')), 'denylist.txt');
  writeFileSync(list, denylist);
  const r = spawnSync(process.execPath, [GUARD, list], { cwd: root, encoding: 'utf8' });
  assert.ok(!new RegExp(TERM, 'i').test(r.stdout + r.stderr), `the guard output repeats the term:\n${r.stdout}${r.stderr}`);
  return r;
}

test('a PNG-like binary with the term inside its bytes is skipped; the same term in a text file is still reported', () => {
  const png = Buffer.concat([PNG_SIGNATURE, Buffer.from(`\x01\x02${TERM}\x03`, 'latin1'), Buffer.alloc(64, 7)]);
  const r = repo({ 'evidence/screen.png': png, 'docs/notes.md': `# Notes\nthis line says ${TERM}\n` });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stdout, 'docs/notes.md:2: rule 1 (denylist line 1)\n', 'only the text file is reported');
  assert.match(r.stderr, /1 binary file\(s\) checked by path only/);
});

test('binary is a known image extension or a NUL byte in the first 8 KB; text files and SVG are still read', () => {
  const clean = repo({
    'a.jpg': Buffer.from(`no nul here but an image: ${TERM}`),
    'b.bin': Buffer.concat([Buffer.from([0x00, 0x01]), Buffer.from(TERM)]),
  });
  assert.equal(clean.status, 0, clean.stdout);
  assert.equal(clean.stdout, '');
  assert.match(clean.stderr, /2 binary file\(s\)/);
  const text = repo({ 'icon.svg': `<svg><text>${TERM}</text></svg>\n`, 'late.txt': `${'x'.repeat(9000)}\0 ${TERM}\n` });
  assert.equal(text.status, 1);
  assert.match(text.stdout, /^icon\.svg:1: rule 1 \(denylist line 1\)$/m, 'SVG is text: scanned');
  assert.match(text.stdout, /^late\.txt:1: rule 1 \(denylist line 1\)$/m, 'a NUL only after 8 KB keeps the file as text');
});

test('whole-word rules are unchanged, and a missing denylist still fails closed', () => {
  const words = repo({ 'w.txt': `${TERM}x is not the word\nbut ${TERM} is\n` }, `w:${TERM}\n`);
  assert.equal(words.status, 1);
  assert.equal(words.stdout, 'w.txt:2: rule 1 (denylist line 1)\n');
  const missing = spawnSync(process.execPath, [GUARD, join(tmpdir(), 'no-such-denylist.txt')], { encoding: 'utf8' });
  assert.equal(missing.status, 2, 'still fails closed without a denylist');
});

test('a match prints path, line and rule position only: never the term or the matched line', () => {
  const secretLine = `the launch partner is ${TERM} and this sentence is private`;
  const r = repo({ 'docs/plan.md': `ok\n${secretLine}\n` }, `# comment\n\nother-term\n${TERM}\n`);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, 'docs/plan.md:2: rule 2 (denylist line 4)\n', 'rule 2 is on denylist line 4');
  assert.ok(!r.stdout.includes('launch partner'), 'the matched line is not printed');
});

test('a file name containing the term is printed as its position in git ls-files, for the name and its content', () => {
  // git ls-files order: a.md, docs/<term>-notes.md, z.png  -> the named file is #2.
  const r = repo({ 'a.md': 'clean\n', [`docs/${TERM}-notes.md`]: `x\n${TERM}\n`, [`z-${TERM}.png`]: PNG_SIGNATURE });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, [
    'tracked file #2:0: rule 1 (denylist line 1)',
    'tracked file #2:2: rule 1 (denylist line 1)',
    'tracked file #3:0: rule 1 (denylist line 1)',
    '',
  ].join('\n'), 'a binary file name is still checked, and named by position too');
});

test('generated verify reports under .analucia/evidence/**/verify-*.txt are skipped; other evidence files are not', () => {
  const r = repo({
    '.analucia/evidence/ORD-0001/verify-01.txt': `check 8 output: x:1:${TERM}\n`,
    '.analucia/evidence/ORD-0001/sub/verify-02.txt': `${TERM}\n`,
    '.analucia/evidence/ORD-0001/report.md': `quoted ${TERM}\n`,
    'docs/verify-01.txt': `${TERM}\n`,
  });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, [
    '.analucia/evidence/ORD-0001/report.md:1: rule 1 (denylist line 1)',
    'docs/verify-01.txt:1: rule 1 (denylist line 1)',
    '',
  ].join('\n'));
  assert.match(r.stderr, /2 verify report\(s\) checked by path only/);
});
