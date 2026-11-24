// ORD-0047 part 8 (OBS-210): every owner command prints the project it runs in and stops in the wrong place; a
// launcher carries its project; a command given to the owner says first in which window it goes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LAUNCHERS, installLaunchers } from '../lib/launchers.mjs';
import { ownerCommand, projectName, whereCheck, whichWindow, isOwnerCommand } from '../lib/where.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env };
delete env.CLAUDE_PROJECT_DIR;
const aos = (args, cwd) => spawnSync(process.execPath, [AOS, ...args], { encoding: 'utf8', input: '', env, cwd });

function project(code) {
  const root = mkdtempSync(join(tmpdir(), 'aos-where-'));
  mkdirSync(join(root, '.analucia'), { recursive: true });
  writeFileSync(join(root, '.analucia', 'project.json'), `${JSON.stringify({ wip_limit: 1, locale: 'es', ...(code ? { project_code: code } : {}) })}\n`);
  writeFileSync(join(root, '.analucia', 'events.jsonl'), '');
  return root;
}

test('which commands are the owner\'s', () => {
  for (const c of ['init', 'sign', 'halt', 'resume', 'repair-log']) assert.equal(isOwnerCommand(c, []), true, c);
  assert.equal(isOwnerCommand('permissions', ['apply']), true);
  assert.equal(isOwnerCommand('permissions', ['check']), false);
  assert.equal(isOwnerCommand('ceo', ['import']), true);
  assert.equal(isOwnerCommand('status', []), false);
});

test('whereCheck: a project root passes, another project and a folder that is not a project stop', () => {
  const root = project('SHOP');
  assert.equal(projectName(root), 'SHOP');
  assert.equal(whereCheck(root, { command: 'sign', project: 'SHOP' }).problem, null);
  assert.equal(whereCheck(root, { command: 'sign', project: basename(root) }).problem, null, 'the folder name is accepted too');
  assert.equal(whereCheck(root, { command: 'sign', project: 'shop' }).problem, null, 'case does not matter');
  const other = whereCheck(root, { command: 'sign', project: 'WEB', locale: 'en' });
  assert.match(other.problem, /written for the project WEB/);
  assert.match(other.line, /^Project: SHOP /);
  const empty = mkdtempSync(join(tmpdir(), 'aos-where-empty-'));
  assert.match(whereCheck(empty, { command: 'sign', locale: 'en' }).problem, /not the root of a project/);
  assert.equal(whereCheck(empty, { command: 'init' }).problem, null, 'init runs where there is no project yet');
  assert.match(whereCheck(empty, { command: 'init', project: 'WEB', locale: 'en' }).problem, /written for the project WEB/);
});

test('an owner command in the wrong place prints the project first, stops with E_WRONG_PLACE and changes nothing', () => {
  const root = project('SHOP');
  const wrong = aos(['halt', '--reason', 'x', '--project', 'WEB', '--root', root], root);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /E_WRONG_PLACE/);
  assert.match(wrong.stderr, /WEB/);
  assert.equal(wrong.stdout, '', 'the project line is not printed as if it had run');
  const none = aos(['sign', '--root', mkdtempSync(join(tmpdir(), 'aos-where-none-'))], root);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /E_WRONG_PLACE/);
  // in the right place the first line names the project (then the terminal guard answers: no TTY here)
  const right = aos(['halt', '--reason', 'x', '--project', 'SHOP', '--root', root], root);
  assert.match(right.stdout.split('\n')[0], /^Proyecto: SHOP /);
  assert.match(right.stderr, /E_OWNER_TTY/);
});

test('a launcher carries the project it was written for', () => {
  const root = project('SHOP');
  installLaunchers(root, { platform: 'win32' });
  for (const l of LAUNCHERS) {
    const text = spawnSync(process.execPath, ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(join(root, `${l.name}.cmd`))}, 'utf8'))`], { encoding: 'utf8' }).stdout;
    if (l.name === 'ACTUALIZAR') assert.doesNotMatch(text, /--project/);
    else assert.match(text, /--project SHOP/, l.name);
  }
});

test('a command given to the owner says first in which window it goes and carries the check', () => {
  const root = project('SHOP');
  assert.match(ownerCommand(root, 'init --check'), / init --check --project SHOP$/);
  assert.equal(whichWindow(root, { locale: 'en' }), 'It goes in the terminal of the project SHOP:');
  assert.match(whichWindow(root, { launcher: 'FIRMAR', locale: 'es' }), /Va en la ventana FIRMAR del proyecto SHOP/);
});
