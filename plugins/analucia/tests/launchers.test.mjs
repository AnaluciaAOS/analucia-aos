// ORD-0040 part 4: click launchers for the owner-only commands. `aos launchers install` writes INICIAR, FIRMAR,
// DETENER, REANUDAR and IMPORTAR as .cmd and .sh from one template; any role may install them (files only). Each
// launcher finds the plugin through CLAUDE_CONFIG_DIR and takes the installed version by numeric order. The terminal
// guard stays on every owner-only command.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LAUNCHERS, LAUNCHER_NAMES, NOT_FOUND_EXIT, RUNNER, installLaunchers, launcherFile, launcherText } from '../lib/launchers.mjs';
import { findBash } from '../lib/lifecycle.mjs';
import { LOCALES, catalog } from '../lib/onboarding.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
delete env.CLAUDE_PROJECT_DIR;
delete env.CLAUDE_CONFIG_DIR;
const aosIn = (cwd, args, input = '') => spawnSync(process.execPath, [AOS, ...args], { encoding: 'utf8', input, env, cwd });
const scratch = () => mkdtempSync(join(tmpdir(), 'aos-launch-'));
const FILES = LAUNCHER_NAMES.flatMap((n) => [`${n}.cmd`, `${n}.sh`]);

// A stand-in Claude Code configuration folder holding these plugin versions; each copy prints its version and arguments.
function fakeConfig(versions) {
  const cfg = mkdtempSync(join(tmpdir(), 'aos-launch-cfg-'));
  for (const v of versions) {
    const bin = join(cfg, 'plugins', 'cache', 'analucia-aos', 'analucia', v, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'aos.mjs'), `process.stdout.write('version ${v} args ' + process.argv.slice(2).join(' ') + '\\n');\n`);
  }
  return cfg;
}
const runner = (dir, args, extraEnv = {}) => spawnSync(process.execPath, ['-e', RUNNER, dir, ...args], { encoding: 'utf8', env: { ...env, ...extraEnv } });

test('aos launchers install writes one launcher file per name, the one this system opens (ORD-0046 part 7), and is idempotent', () => {
  const dir = scratch();
  const r = aosIn(dir, ['launchers', 'install']);
  assert.equal(r.status, 0, r.stderr);
  const mine = LAUNCHER_NAMES.map((n) => launcherFile(n));
  for (const f of mine) assert.ok(r.stdout.includes(`${f}:`), `reported: ${f}`);
  assert.equal(r.stdout.split('\n').filter((l) => /^\S+\.(cmd|sh):/.test(l)).length, LAUNCHER_NAMES.length, 'one file per launcher');
  // The texts of both systems, written through the library (each system writes only its own).
  installLaunchers(dir, { platform: 'win32' });
  installLaunchers(dir, { platform: 'linux' });
  const texts = Object.fromEntries(FILES.map((f) => [f, readFileSync(join(dir, f), 'utf8')]));
  assert.equal(FILES.length, 18); // nine launchers, two texts each
  for (const l of LAUNCHERS) {
    const line = `${l.args.join(' ')}${l.name === 'ACTUALIZAR' ? '' : ` --project ${basename(dir)}`}`;
    assert.ok(texts[`${l.name}.cmd`].includes(`" "%~dp0." ${line}${l.drop ? ' %*' : ''}\r\n`), `${l.name}.cmd runs aos ${line}`);
    assert.ok(texts[`${l.name}.sh`].includes(`" "$PWD" ${line}${l.drop ? ' "$@"' : ''}\n`), `${l.name}.sh runs aos ${line}`);
    assert.match(texts[`${l.name}.cmd`], /\r\npause\r\n$/, 'the window stays open (.cmd)');
    assert.match(texts[`${l.name}.sh`], /\nread -r _\n$/, 'the window stays open (.sh)');
    assert.doesNotMatch(texts[`${l.name}.sh`], /\r/);
  }
  assert.deepEqual(LAUNCHERS.map((l) => [l.name, l.args.join(' ')]), [['INICIAR', 'init'], ['FIRMAR', 'sign'], ['DETENER', 'halt'], ['REANUDAR', 'resume'], ['IMPORTAR', 'ceo import'], ['REPARAR', 'repair-log'], ["ACTUALIZAR", "update"], ["ESTADO", "status --owner"], ["PERMISOS", "permissions apply"]]);
  for (const [f, text] of Object.entries(texts)) {
    assert.ok(text.includes('CLAUDE_CONFIG_DIR'), `${f} honours CLAUDE_CONFIG_DIR`);
    for (const personal of [homedir(), homedir().replace(/\\/g, '/'), dir, dir.replace(/\\/g, '/'), tmpdir()]) assert.ok(!text.includes(personal), `${f} contains ${personal}`);
    assert.doesNotMatch(text, /[A-Za-z]:\\Users\\|\/home\/|\/Users\/|users[\\/]/i, f);
  }
  // Idempotent: a second run changes no byte and says so.
  assert.deepEqual(installLaunchers(dir).map((x) => x.status), Array(LAUNCHER_NAMES.length).fill('unchanged'));
  aosIn(dir, ['launchers', 'install']);
  for (const f of FILES) assert.equal(readFileSync(join(dir, f), 'utf8'), texts[f], f);
  // A changed launcher is brought back.
  writeFileSync(join(dir, launcherFile('FIRMAR')), 'old');
  assert.deepEqual(installLaunchers(dir).filter((x) => x.status !== 'unchanged').map((x) => [x.file, x.status]), [[launcherFile('FIRMAR'), 'updated']]);
});

test('one template: the runner is the same text in every launcher and safe inside both shells', () => {
  assert.doesNotMatch(RUNNER, /["%$`\\\n]/, 'no character that a batch file or a quoted sh string would change');
  for (const locale of LOCALES) {
    const t = catalog(locale);
    for (const l of LAUNCHERS) {
      const { cmd, sh } = launcherText(l, t);
      assert.ok(cmd.includes(`node -e "${RUNNER}" `) && sh.includes(`node -e "${RUNNER}" `), `${locale} ${l.name}`);
      for (const line of cmd.split('\r\n').filter((x) => /^(echo |if %errorlevel%)/.test(x))) assert.doesNotMatch(line.replace(/^if %errorlevel%==\d+ /, ''), /[%&|<>^"!()]/, `${locale} ${l.name}: ${line}`);
      for (const line of sh.split('\n').filter((x) => /echo "|printf/.test(x))) assert.doesNotMatch(line.replace(/^.*?(echo|printf '\\n%s ') "/, '').replace(/"$/, ''), /["$`\\]/, `${locale} ${l.name}: ${line}`);
    }
  }
});

test('the installed version is chosen by number: 0.10.0 is newer than 0.9.0', () => {
  const dir = scratch();
  const cfg = fakeConfig(['0.2.0', '0.9.0', '0.10.0', '0.3.11']);
  mkdirSync(join(cfg, 'plugins', 'cache', 'analucia-aos', 'analucia', 'not-a-version', 'bin'), { recursive: true });
  mkdirSync(join(cfg, 'plugins', 'cache', 'analucia-aos', 'analucia', '0.11.0')); // a newer folder without the CLI is not chosen
  const r = runner(dir, ['sign'], { CLAUDE_CONFIG_DIR: cfg });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'version 0.10.0 args sign\n');
  assert.equal(runner(dir, ['ceo', 'import', 'sheet.xlsx'], { CLAUDE_CONFIG_DIR: fakeConfig(['1.2.0', '1.10.0', '1.9.9']) }).stdout, 'version 1.10.0 args ceo import sheet.xlsx\n');
  // No copy of the plugin: the runner says so with its own exit code, and the launcher prints one plain line.
  assert.equal(runner(dir, ['sign'], { CLAUDE_CONFIG_DIR: fakeConfig([]) }).status, NOT_FOUND_EXIT);
  // A copy of the plugin next to the launcher (the plugin's own repository) wins over the installed one.
  mkdirSync(join(dir, 'plugins', 'analucia', 'bin'), { recursive: true });
  writeFileSync(join(dir, 'plugins', 'analucia', 'bin', 'aos.mjs'), "process.stdout.write('local copy\\n');\n");
  assert.equal(runner(dir, ['sign'], { CLAUDE_CONFIG_DIR: cfg }).stdout, 'local copy\n');
});

test('a launcher run as a file honours CLAUDE_CONFIG_DIR and passes the command on', () => {
  const dir = scratch();
  installLaunchers(dir, { locale: 'en' });
  installLaunchers(dir, { locale: 'en', platform: 'linux' }); // the .sh is exercised below too, where a POSIX shell exists
  const cfg = fakeConfig(['0.9.0', '0.10.0']);
  const file = launcherFile('REANUDAR');
  // Standard input is closed, so the "press a key" at the end returns at once.
  const run = (f, extra) => (process.platform === 'win32'
    ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', `.\\${f}`], { cwd: dir, encoding: 'utf8', input: '', env: { ...env, ...extra } })
    : spawnSync('sh', [`./${f}`], { cwd: dir, encoding: 'utf8', input: '', env: { ...env, ...extra } }));
  const r = run(file, { CLAUDE_CONFIG_DIR: cfg });
  assert.match(r.stdout, /version 0\.10\.0 args resume --project /, r.stdout + r.stderr);
  const none = run(file, { CLAUDE_CONFIG_DIR: fakeConfig([]) });
  assert.match(none.stdout, /The Analucia plugin was not found on this computer/);
  // The .sh too, where a POSIX shell exists (Git Bash on Windows).
  const bash = findBash();
  const sh = spawnSync(bash, ['./IMPORTAR.sh', 'my sheet.xlsx'], { cwd: dir, encoding: 'utf8', input: '', env: { ...env, CLAUDE_CONFIG_DIR: cfg } });
  if (sh.error) return;
  assert.match(sh.stdout, /version 0\.10\.0 args ceo import --project [^ ]+ my sheet\.xlsx/, sh.stdout + sh.stderr);
});

test('aos sign --install-launcher keeps working, and the terminal guard stays on every owner-only command', () => {
  const dir = scratch();
  const r = aosIn(dir, ['sign', '--install-launcher']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(readFileSync(join(dir, launcherFile('FIRMAR')), 'utf8').length > 0);
  mkdirSync(join(dir, '.analucia'), { recursive: true }); // the guards of a project folder: where the owner commands run
  // No terminal (an agent, a pipe): every command behind a launcher is refused, whatever is piped in.
  for (const [args, input] of [[['sign'], 'CLOSE\n'], [['init'], '1\n'], [['halt'], 'because\n'], [['halt', '--reason', 'x'], ''], [['resume'], ''], [['ceo', 'import'], 'sheet.xlsx\n'], [['ceo', 'import', 'sheet.xlsx'], 'CONFIRM\n']]) {
    const x = aosIn(dir, args, input);
    assert.notEqual(x.status, 0, args.join(' '));
    assert.match(x.stderr, /E_OWNER_TTY/, `aos ${args.join(' ')}: ${x.stderr}`);
  }
});
