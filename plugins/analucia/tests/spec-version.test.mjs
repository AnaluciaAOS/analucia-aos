// ORD-0047 part 14 (OBS-187): a core spec whose text differs from the one on main while its version line does not is
// an error of aos validate (E_SPEC_VERSION); a new version, a line-ending change, or no copy on main is not.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { specVersionProblems, versionOf } from '../lib/spec-version.mjs';
import { validateTree } from '../lib/validate.mjs';
import { logPath } from '../lib/log.mjs';

const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'core.autocrlf=false', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { encoding: 'utf8' });
const spec = (version, body) => `---\nid: SPEC-0009\nversion: ${version}\n---\n\n${body}\n`;

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'aos-specver-'));
  mkdirSync(join(root, 'core'));
  mkdirSync(join(root, '.analucia'));
  writeFileSync(join(root, '.analucia', 'project.json'), '{"locale":"en"}\n');
  writeFileSync(logPath(root), '');
  writeFileSync(join(root, 'core', 'SPEC-0009-DEMO.md'), spec('0.1.0', 'one'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  return root;
}

test('the version is the spec\'s own line', () => assert.equal(versionOf(spec('1.2.3', 'x')), '1.2.3'));

test('a changed text with the same version is refused; with a new version, or untouched, it is not', () => {
  const root = repo();
  assert.deepEqual(specVersionProblems(root), [], 'untouched');
  writeFileSync(join(root, 'core', 'SPEC-0009-DEMO.md'), spec('0.1.0', 'two'));
  const p = specVersionProblems(root);
  assert.equal(p.length, 1);
  assert.equal(p[0].file, 'core/SPEC-0009-DEMO.md');
  const tree = validateTree(root).filter((e) => e.code === 'E_SPEC_VERSION');
  assert.equal(tree.length, 1, 'aos validate reports it');
  assert.equal(tree[0].file, 'core/SPEC-0009-DEMO.md');
  writeFileSync(join(root, 'core', 'SPEC-0009-DEMO.md'), spec('0.1.1', 'two'));
  assert.deepEqual(specVersionProblems(root), [], 'a new version');
});

test('line endings are not a change; a spec with no copy on main, or no git, is not judged', () => {
  const root = repo();
  writeFileSync(join(root, 'core', 'SPEC-0009-DEMO.md'), spec('0.1.0', 'one').replace(/\n/g, '\r\n'));
  assert.deepEqual(specVersionProblems(root), []);
  writeFileSync(join(root, 'core', 'SPEC-0010-NEW.md'), spec('0.1.0', 'brand new'));
  assert.deepEqual(specVersionProblems(root), []);
  const nogit = mkdtempSync(join(tmpdir(), 'aos-specver-nogit-'));
  mkdirSync(join(nogit, 'core'));
  writeFileSync(join(nogit, 'core', 'SPEC-0009-DEMO.md'), spec('0.1.0', 'x'));
  assert.deepEqual(specVersionProblems(nogit), []);
});
