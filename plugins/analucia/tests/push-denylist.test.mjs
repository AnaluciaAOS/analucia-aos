// ORD-0046 part 1 (OBS-198): the push guard checks every added line of every pushed commit against the list of
// forbidden names named by release_denylist. A name removed by a later commit still refuses the push; the word is
// never printed; with the key absent nothing changes; with the key set and the file missing the push is refused.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkPush } from '../lib/guards.mjs';
import { parseDenylist } from '../lib/denylist.mjs';

const GUARD = fileURLToPath(new URL('../../../scripts/release-guard.mjs', import.meta.url));
const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, '-c', 'core.autocrlf=false', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' });
const WORD = 'zorblaxq'; // made up, so the test never repeats a real forbidden name
const env = {};

function repo(mode) {
  const root = mkdtempSync(join(tmpdir(), 'aos-deny-'));
  const list = join(mkdtempSync(join(tmpdir(), 'aos-deny-list-')), 'list.txt');
  writeFileSync(list, `${WORD}\n`);
  const key = mode === 'set' ? { release_denylist: list } : mode === 'missing' ? { release_denylist: join(root, 'nope.txt') } : {};
  mkdirSync(join(root, '.analucia'), { recursive: true });
  writeFileSync(join(root, '.analucia', 'project.json'), JSON.stringify({ github_owner: 'example', ...key }));
  writeFileSync(join(root, '.analucia', 'events.jsonl'), `${JSON.stringify({ type: 'run.started', subject: 'ORD-0001', ts: '2026-01-01T00:00:00.000Z' })}\n`);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'remote', 'add', 'origin', 'https://example@github.com/example/shop.git');
  git(root, 'config', 'credential.https://github.com.username', 'example');
  writeFileSync(join(root, 'a.txt'), 'one\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base\n\nAnalucia-Order: ORD-0001');
  return root;
}
const commit = (root, file, text, msg) => {
  writeFileSync(join(root, file), text);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', `${msg}\n\nAnalucia-Order: ORD-0001`);
};
const push = (root) => { try { return { ok: checkPush(root, { env }) }; } catch (e) { return { err: e }; } };
const shown = (e) => `${e.message}\n${(e.problems ?? []).join('\n')}`;

test('a name in a middle commit that a later commit removes is still refused, naming commit, file and line, never the word', () => {
  const root = repo('set');
  commit(root, 'b.txt', `ok\nsecond ${WORD} here\n`, 'middle');
  const middle = git(root, 'rev-parse', '--short=7', 'HEAD').stdout.trim();
  commit(root, 'b.txt', 'ok\nclean\n', 'removes it');
  const r = push(root);
  assert.equal(r.err?.code, 'E_DENYLIST');
  assert.ok(r.err.problems.includes(`${middle} b.txt:2 (rule 1)`), shown(r.err));
  assert.ok(!shown(r.err).toLowerCase().includes(WORD), 'the word is never printed');
});

test('a clean push passes; the key absent changes nothing even if a commit has the word', () => {
  const clean = repo('set');
  commit(clean, 'b.txt', 'fine\n', 'clean');
  assert.ok(push(clean).ok, JSON.stringify(push(clean).err?.message));
  const absent = repo('none');
  commit(absent, 'b.txt', `${WORD}\n`, 'has the word');
  assert.ok(push(absent).ok, 'no key, no check');
});

test('the key set and the file missing refuses the push and says so', () => {
  const root = repo('missing');
  commit(root, 'b.txt', 'fine\n', 'clean');
  const r = push(root);
  assert.equal(r.err?.code, 'E_DENYLIST');
  assert.match(r.err.message, /not there/);
});

test('a file name on the list is refused without printing the name', () => {
  const root = repo('set');
  commit(root, `${WORD}.txt`, 'fine\n', 'named');
  const r = push(root);
  assert.equal(r.err?.code, 'E_DENYLIST');
  assert.ok(!shown(r.err).toLowerCase().includes(WORD));
});

test('the release guard script imports the plugin matcher and keeps no copy of it', () => {
  const src = readFileSync(GUARD, 'utf8');
  assert.match(src, /from '\.\.\/plugins\/analucia\/lib\/denylist\.mjs'/);
  assert.ok(!/new RegExp\(/.test(src), 'no regular expression built in the script');
});

test('the matcher gives the release guard the same verdicts on terms, whole words and comments', () => {
  const list = `# comment\n${WORD}\nw:cat\n`;
  const rules = parseDenylist(list);
  assert.deepEqual(rules.map((r) => [r.id, r.line]), [[1, 2], [2, 3]]);
  const whole = rules[1].re;
  assert.ok(whole.test('a cat b') && !whole.test('concatenate') && !whole.test('cat9'), 'a whole-word rule does not match inside a word');
  const texts = [`a ${WORD.toUpperCase()} b`, 'a cat b', 'concatenate', '# comment', 'nothing'];
  const root = mkdtempSync(join(tmpdir(), 'aos-deny-agree-'));
  git(root, 'init', '-q');
  texts.forEach((t, i) => writeFileSync(join(root, `f${i}.txt`), `${t}\n`));
  git(root, 'add', '-A');
  const lf = join(mkdtempSync(join(tmpdir(), 'aos-deny-agree-list-')), 'l.txt');
  writeFileSync(lf, list);
  const g = spawnSync(process.execPath, [GUARD, lf], { cwd: root, encoding: 'utf8' });
  const guardFiles = new Set([...g.stdout.matchAll(/^(f\d)\.txt:/gm)].map((m) => m[1]));
  texts.forEach((t, i) => assert.equal(rules.some((r) => r.re.test(t)), guardFiles.has(`f${i}`), t));
});
