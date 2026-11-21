// ORD-0043 part 7: the plugin is updated without the owner. `aos update` runs the `claude` command-line tool (here a
// stand-in that records its calls); the tool not found changes nothing and says so; `aos next` and the SessionStart
// line warn when the installed plugin is older than what the machine can see; the two marketplace names.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LAUNCHER_NAMES } from '../lib/launchers.mjs';
import { LOCALES, catalog } from '../lib/onboarding.mjs';
import { PRIVATE_MARKETPLACE, PUBLIC_MARKETPLACE, findClaude, updateWarning } from '../lib/update.mjs';
import { MARKETPLACE_FILE, PUBLIC_MARKETPLACE as BUILDER_NAME, publicBytes } from '../../../scripts/build-public-tree.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const scratch = (p = 'aos-update-') => mkdtempSync(join(tmpdir(), p));
const NODE_DIR = dirname(process.execPath);

// A stand-in for the claude tool: it keeps its state (the installations) in state.json next to itself, appends every
// call to calls.log, and "updates" each installation to the version of state.available.
function standIn({ installs, available = '0.6.0', fail = null }) {
  const dir = scratch('aos-claude-');
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ installs, available, fail }));
  writeFileSync(join(dir, 'standin.mjs'), [
    "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';",
    "import { dirname, join } from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    'const here = dirname(fileURLToPath(import.meta.url));',
    "const state = JSON.parse(readFileSync(join(here, 'state.json'), 'utf8'));",
    'const args = process.argv.slice(2);',
    "appendFileSync(join(here, 'calls.log'), JSON.stringify({ args, cfg: process.env.CLAUDE_CONFIG_DIR ?? null, stdinTTY: Boolean(process.stdin.isTTY) }) + '\\n');",
    "const line = args.join(' ');",
    "if (state.fail && line.startsWith(state.fail.on)) { process.stderr.write(state.fail.text + '\\n'); process.exit(1); }",
    "if (line === 'plugin list --json') { process.stdout.write(JSON.stringify(state.installs)); process.exit(0); }",
    "if (line.startsWith('plugin marketplace update ')) { process.stdout.write('updated\\n'); process.exit(0); }",
    "if (line.startsWith('plugin update ')) {",
    "  const scope = args[args.indexOf('--scope') + 1];",
    '  for (const i of state.installs) if (i.id === args[2] && i.scope === scope) i.version = state.available;',
    "  writeFileSync(join(here, 'state.json'), JSON.stringify(state));",
    '  process.exit(0);',
    '}',
    'process.exit(3);',
  ].join('\n'));
  if (process.platform === 'win32') writeFileSync(join(dir, 'claude.cmd'), '@echo off\r\nnode "%~dp0standin.mjs" %*\r\n');
  else { writeFileSync(join(dir, 'claude'), '#!/bin/sh\nexec node "$(dirname "$0")/standin.mjs" "$@"\n'); chmodSync(join(dir, 'claude'), 0o755); }
  return { dir, calls: () => (existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []) };
}
// An environment where the only claude tool is the stand-in (or none), with a scratch home and configuration folder.
function envWith(toolDir) {
  const home = scratch('aos-home-');
  const env = { ...process.env, PATH: [toolDir, NODE_DIR].filter(Boolean).join(delimiter), HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData'), CLAUDE_CONFIG_DIR: join(home, 'cfg'), LC_ALL: 'en_US.UTF-8' };
  delete env.Path; delete env.CLAUDE_PROJECT_DIR; delete env.CLAUDE_CODE_SESSION_ID;
  return env;
}
const aos = (cwd, args, env, input = '') => spawnSync(process.execPath, [AOS, ...args], { encoding: 'utf8', cwd, env, input });

test('aos update: the marketplace the plugin came from, then the plugin in every scope, through the tool; versions before and after; one closing line', () => {
  const project = scratch();
  const tool = standIn({ installs: [
    { id: `analucia@${PUBLIC_MARKETPLACE}`, version: '0.4.0', scope: 'user' },
    { id: `analucia@${PUBLIC_MARKETPLACE}`, version: '0.5.0', scope: 'project', projectPath: project },
    { id: 'other@elsewhere', version: '1.0.0', scope: 'user' },
  ] });
  const env = envWith(tool.dir);
  const r = aos(project, ['update'], env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const calls = tool.calls();
  assert.deepEqual(calls.map((c) => c.args.join(' ')), [
    'plugin list --json',
    `plugin marketplace update ${PUBLIC_MARKETPLACE}`,
    `plugin update analucia@${PUBLIC_MARKETPLACE} --scope user`,
    `plugin update analucia@${PUBLIC_MARKETPLACE} --scope project`,
    'plugin list --json',
  ]);
  // It honours CLAUDE_CONFIG_DIR (passed on as it is) and never gives the tool a terminal to wait on.
  assert.ok(calls.every((c) => c.cfg === env.CLAUDE_CONFIG_DIR && c.stdinTTY === false));
  assert.match(r.stdout, /user: before 0\.4\.0, after 0\.6\.0/);
  assert.match(r.stdout, /project: before 0\.5\.0, after 0\.6\.0/);
  const lines = r.stdout.trimEnd().split('\n');
  assert.match(lines.at(-1), /^OK: /);
  assert.equal(lines.filter((l) => l.startsWith('OK: ')).length, 1);
  // It wrote nothing in the configuration folder by hand.
  assert.equal(existsSync(env.CLAUDE_CONFIG_DIR), false);
});

test('aos update: the tool not found, a sign-in asked, or no installation: nothing is changed and it says exactly that', () => {
  const none = aos(scratch(), ['update'], envWith(null));
  assert.equal(none.status, 1);
  assert.match(none.stdout + none.stderr, /claude/);
  assert.match(none.stdout + none.stderr, /nothing was changed/i);
  assert.doesNotMatch(none.stdout, /^OK: /m);

  const asks = standIn({ installs: [{ id: `analucia@${PUBLIC_MARKETPLACE}`, version: '0.4.0', scope: 'user' }], fail: { on: 'plugin marketplace update', text: 'Please sign in to continue' } });
  const signIn = aos(scratch(), ['update'], envWith(asks.dir));
  assert.equal(signIn.status, 1);
  assert.match(signIn.stdout + signIn.stderr, /sign-in/i);
  assert.match(signIn.stdout + signIn.stderr, /nothing was changed/i);
  assert.ok(!asks.calls().some((c) => c.args[1] === 'update'), 'the plugin was not updated');

  const empty = standIn({ installs: [] });
  const notInstalled = aos(scratch(), ['update'], envWith(empty.dir));
  assert.equal(notInstalled.status, 1);
  assert.match(notInstalled.stdout + notInstalled.stderr, /not installed/i);
  assert.equal(empty.calls().length, 1);
});

test('findClaude: the PATH first, then the usual places; null when it is nowhere', () => {
  const home = scratch('aos-home-');
  assert.equal(findClaude({ PATH: NODE_DIR, HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData') }), null);
  const usual = join(home, '.local', 'bin');
  mkdirSync(usual, { recursive: true });
  const name = process.platform === 'win32' ? 'claude.exe' : 'claude';
  writeFileSync(join(usual, name), '');
  assert.equal(findClaude({ PATH: NODE_DIR, HOME: home, USERPROFILE: home }), join(usual, name));
  const onPath = scratch();
  writeFileSync(join(onPath, name), '');
  assert.equal(findClaude({ PATH: onPath, HOME: home, USERPROFILE: home }), join(onPath, name));
});

// A configuration folder with one installed copy in the cache and the marketplace copy next to it.
function config({ market = PUBLIC_MARKETPLACE, installed, marketplaceCopy }) {
  const cfg = scratch('aos-cfg-');
  const copy = join(cfg, 'plugins', 'cache', market, 'analucia', installed);
  mkdirSync(join(copy, 'bin'), { recursive: true });
  mkdirSync(join(copy, '.claude-plugin'), { recursive: true });
  writeFileSync(join(copy, 'bin', 'aos.mjs'), '');
  writeFileSync(join(copy, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'analucia', version: installed }));
  if (marketplaceCopy) {
    const m = join(cfg, 'plugins', 'marketplaces', market, 'plugins', 'analucia', '.claude-plugin');
    mkdirSync(m, { recursive: true });
    writeFileSync(join(m, 'plugin.json'), JSON.stringify({ name: 'analucia', version: marketplaceCopy }));
  }
  return { cfg, copy };
}

test('the warning: installed older than the marketplace copy next to it, or than the plugin source of the project; never when it is current', () => {
  const old = config({ installed: '0.4.0', marketplaceCopy: '0.6.0' });
  assert.deepEqual(updateWarning(null, { env: { CLAUDE_CONFIG_DIR: old.cfg }, pluginDir: old.copy }), { installed: '0.4.0', newest: '0.6.0' });
  const current = config({ installed: '0.6.0', marketplaceCopy: '0.6.0' });
  assert.equal(updateWarning(null, { env: { CLAUDE_CONFIG_DIR: current.cfg }, pluginDir: current.copy }), null);
  // 0.10.0 is newer than 0.9.0: numeric order.
  const ten = config({ installed: '0.9.0', marketplaceCopy: '0.10.0' });
  assert.deepEqual(updateWarning(null, { env: { CLAUDE_CONFIG_DIR: ten.cfg }, pluginDir: ten.copy }), { installed: '0.9.0', newest: '0.10.0' });
  // A project that carries the plugin source: that source is what the machine can see.
  const project = scratch();
  mkdirSync(join(project, 'plugins', 'analucia', '.claude-plugin'), { recursive: true });
  writeFileSync(join(project, 'plugins', 'analucia', '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '0.7.0' }));
  assert.deepEqual(updateWarning(project, { env: { CLAUDE_CONFIG_DIR: current.cfg }, pluginDir: current.copy }), { installed: '0.6.0', newest: '0.7.0' });
  // The private marketplace is followed under its own name.
  const priv = config({ market: PRIVATE_MARKETPLACE, installed: '0.6.0', marketplaceCopy: '0.7.0' });
  assert.deepEqual(updateWarning(null, { env: { CLAUDE_CONFIG_DIR: priv.cfg }, pluginDir: priv.copy }), { installed: '0.6.0', newest: '0.7.0' });
  // Nothing installed in this configuration folder: nothing to warn about.
  assert.equal(updateWarning(null, { env: { CLAUDE_CONFIG_DIR: scratch('aos-cfg-') } }), null);
});

test('aos next and the SessionStart line carry the warning in one line with the command, and never block', () => {
  const old = config({ installed: '0.4.0', marketplaceCopy: '0.6.0' });
  const env = { ...envWith(null), CLAUDE_CONFIG_DIR: old.cfg };
  const dir = scratch();
  const next = aos(dir, ['next'], env);
  assert.equal(next.status, 0);
  assert.equal(next.stdout.trimEnd().split('\n').length, 1, 'the next step is still one line on stdout');
  const warn = next.stderr.trimEnd().split('\n').filter((l) => /0\.4\.0/.test(l));
  assert.equal(warn.length, 1);
  assert.match(warn[0], /0\.6\.0/);
  assert.match(warn[0], /bin\/aos\.mjs" update/);
  const hook = aos(dir, ['hook', 'session-start'], env, JSON.stringify({ cwd: dir, session_id: 's1', hook_event_name: 'SessionStart' }));
  assert.equal(hook.status, 0);
  assert.equal(hook.stdout.split('\n').filter((l) => /0\.4\.0/.test(l) && /update/.test(l)).length, 1);
  // Current: no warning anywhere.
  const current = config({ installed: '0.7.0', marketplaceCopy: '0.7.0' });
  const quiet = aos(dir, ['next'], { ...env, CLAUDE_CONFIG_DIR: current.cfg });
  assert.equal(quiet.stderr, '');
});

test('the two marketplace names: the private repository has its own, the public tree keeps analucia-aos', () => {
  // In the private repository the file carries the private name; inside a built public tree, the public one.
  const onDisk = readFileSync(join(REPO, '.claude-plugin', 'marketplace.json'), 'utf8');
  const privateRepo = existsSync(join(REPO, '.analucia', 'events.jsonl'));
  assert.equal(JSON.parse(onDisk).name, privateRepo ? PRIVATE_MARKETPLACE : PUBLIC_MARKETPLACE);
  const file = Buffer.from(onDisk.replace(`"${PUBLIC_MARKETPLACE}"`, `"${PRIVATE_MARKETPLACE}"`));
  const pub = JSON.parse(publicBytes(MARKETPLACE_FILE, file).toString('utf8'));
  assert.equal(pub.name, PUBLIC_MARKETPLACE);
  assert.equal(BUILDER_NAME, PUBLIC_MARKETPLACE);
  // Nothing else of the file changes, and no other file is touched.
  assert.deepEqual({ ...pub, name: PRIVATE_MARKETPLACE }, JSON.parse(file.toString('utf8')));
  const other = Buffer.from('{"name": "x"}');
  assert.equal(publicBytes('plugins/analucia/.claude-plugin/plugin.json', other), other);
  // A file that already carries the public name is written byte for byte.
  const already = Buffer.from(file.toString('utf8').replace(PRIVATE_MARKETPLACE, PUBLIC_MARKETPLACE));
  assert.equal(publicBytes(MARKETPLACE_FILE, already), already);
});

test('the ACTUALIZAR launcher is written with the others and runs aos update; its text is in the five locales', () => {
  assert.ok(LAUNCHER_NAMES.includes('ACTUALIZAR'));
  const dir = scratch();
  const env = envWith(null);
  assert.equal(aos(dir, ['launchers', 'install'], env).status, 0);
  assert.match(readFileSync(join(dir, 'ACTUALIZAR.cmd'), 'utf8'), /" "%~dp0\." update\r\n/);
  assert.match(readFileSync(join(dir, 'ACTUALIZAR.sh'), 'utf8'), /" "\$PWD" update\n/);
  for (const l of LOCALES) {
    const own = JSON.parse(readFileSync(fileURLToPath(new URL(`../i18n/${l}.json`, import.meta.url)), 'utf8')).strings;
    for (const k of ['launcher.what.ACTUALIZAR', 'update.not_found', 'update.sign_in', 'update.not_installed', 'update.failed', 'update.line', 'update.reopen', 'update.warning', 'ok.update']) assert.ok(own[k], `${l}: ${k}`);
    assert.ok(catalog(l)('update.warning', { installed: '0.4.0', newest: '0.6.0', cmd: 'X' }).includes('0.4.0'));
  }
});
