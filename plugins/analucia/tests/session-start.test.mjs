// ORD-0029 A: the SessionStart hook is never silent and always names the project root it found (or that it found none).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AOS_BIN } from '../lib/cli.mjs';
import { logPath } from '../lib/log.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env, LANG: 'C' };
delete env.CLAUDE_PROJECT_DIR;
const posix = (p) => resolve(p).split(sep).join('/');
// Driven like Claude Code drives it: hook JSON on stdin, no --root, the session folder in "cwd".
const hook = (name, cwd) => spawnSync(process.execPath, [AOS, 'hook', name], { encoding: 'utf8', env, input: JSON.stringify({ session_id: 's-1', cwd, hook_event_name: 'SessionStart', source: 'startup' }) });

function project() {
  const root = mkdtempSync(join(tmpdir(), 'aos-ss-'));
  mkdirSync(join(root, '.analucia', 'orders'), { recursive: true });
  writeFileSync(join(root, '.analucia', 'project.json'), '{"wip_limit":1,"locale":"en"}\n');
  writeFileSync(logPath(root), '');
  mkdirSync(join(root, 'sub', 'deeper'), { recursive: true });
  return root;
}
const noProjectAbove = (dir) => {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, '.analucia'))) return false;
    if (dirname(d) === d) return true;
  }
};

test('a folder that is not initialised gets one line: installed, not initialised, the folder, and the real init command', (t) => {
  const bare = mkdtempSync(join(tmpdir(), 'aos-ss-bare-'));
  if (!noProjectAbove(bare)) return t.skip('a folder above the temp folder holds .analucia');
  const r = hook('session-start', bare);
  assert.equal(r.status, 0);
  const lines = r.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 1, r.stdout);
  assert.ok(lines[0].includes(posix(bare)), 'names the folder it searched from');
  assert.ok(lines[0].endsWith(`node "${AOS_BIN}" init`), 'ends with the command, as it exists on this machine');
  assert.ok(existsSync(AOS_BIN));
  assert.match(lines[0], /installed, but this folder is not initialised|está instalado, pero esta carpeta no está iniciada|instalado, mas esta pasta não foi iniciada|इंस्टॉल है|已安装/);
  // The other hooks stay quiet outside a project, and nothing is written there.
  assert.equal(hook('pre-tool-use', bare).stdout, '');
  assert.equal(existsSync(join(bare, '.analucia')), false);
});

test('in the project root: the Status line first, then the root it found', () => {
  const root = project();
  const r = hook('session-start', root);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n');
  assert.match(lines[0], /^Status: /);
  assert.equal(lines[1], `Project root: ${posix(root)}`);
});

test('in a subfolder of the project: the root above it, and the subfolder the session started in', () => {
  const root = project();
  const sub = join(root, 'sub', 'deeper');
  const lines = hook('session-start', sub).stdout.split('\n');
  assert.match(lines[0], /^Status: /);
  assert.equal(lines[1], `Project root: ${posix(root)} (this session started in the subfolder ${posix(sub)})`);
});

test('the root line follows the project language', () => {
  const root = project();
  writeFileSync(join(root, '.analucia', 'project.json'), '{"wip_limit":1,"locale":"es"}\n');
  assert.equal(hook('session-start', root).stdout.split('\n')[1], `Raíz del proyecto: ${posix(root)}`);
});
