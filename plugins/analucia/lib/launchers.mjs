// Click launchers for the owner-only commands (ORD-0040 part 4): INICIAR, FIRMAR, DETENER, REANUDAR, IMPORTAR,
// each as .cmd and .sh, generated from one template. A launcher opens a real console, where only a person can
// answer, so the terminal guard (E_OWNER_TTY) is not weakened: installing them writes files only.
// The launcher finds aos next to itself (the plugin's own repository) or in the installed plugin, through
// CLAUDE_CONFIG_DIR when it is set, and takes the installed version by numeric order (0.10.0 is newer than 0.9.0).
// No absolute personal path is written into a launcher.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { personLocale } from './locale.mjs';
import { catalog } from './onboarding.mjs';
import { projectName } from './where.mjs';

// name -> the aos arguments it runs. `drop`: a file dropped on the launcher is passed on (the owner sheet).
export const LAUNCHERS = [
  { name: 'INICIAR', args: ['init'] },
  { name: 'FIRMAR', args: ['sign'] },
  { name: 'DETENER', args: ['halt'] },
  { name: 'REANUDAR', args: ['resume'] },
  { name: 'IMPORTAR', args: ['ceo', 'import'], drop: true },
  // ORD-0042 part 4: the one-click repair of the log (owner only; three conditions; lib/log-repair.mjs).
  { name: 'REPARAR', args: ['repair-log'] },
  // ORD-0043 part 7: the plugin is updated by a click (any role may run it: it changes no project file).
  { name: 'ACTUALIZAR', args: ['update'] },
  // ORD-0046 part 2: what runs now, which part it is on and whether it waits for the owner (reads only).
  { name: 'ESTADO', args: ['status', '--owner'] },
  // ORD-0046 part 4: the owner's one button for the permission files (owner only: terminal and typed word).
  { name: 'PERMISOS', args: ['permissions', 'apply'] },
];
export const LAUNCHER_NAMES = LAUNCHERS.map((l) => l.name);
// The launcher file a person clicks on this platform.
export const launcherFile = (name, platform = process.platform) => `${name}.${platform === 'win32' ? 'cmd' : 'sh'}`;
// Exit code of the runner when no copy of the plugin was found.
export const NOT_FOUND_EXIT = 86;

// The runner, the same text in both files: it runs inside `node -e "…"`, so it holds no double quote, percent
// sign, dollar sign, backtick or backslash. argv[1] is the launcher's folder, the rest are the aos arguments.
export const RUNNER = [
  "const fs=require('fs'),path=require('path'),os=require('os'),cp=require('child_process');",
  "const here=process.argv[1];",
  "let aos=path.join(here,'plugins','analucia','bin','aos.mjs');",
  'if(!fs.existsSync(aos)){',
  "const cfg=(process.env.CLAUDE_CONFIG_DIR||'').trim()||path.join(os.homedir(),'.claude');",
  "const cache=path.join(cfg,'plugins','cache');",
  "const num=(v)=>v.split('.').map(Number);",
  'const found=[];',
  // every marketplace the plugin was installed from: the public one and the private one have their own names
  'for(const m of (fs.existsSync(cache)?fs.readdirSync(cache):[])){',
  "const base=path.join(cache,m,'analucia');",
  'for(const v of (fs.existsSync(base)?fs.readdirSync(base):[])){',
  "if(v.split('.').length===3&&v.split('.').every((n)=>String(Number(n))===n)&&fs.existsSync(path.join(base,v,'bin','aos.mjs')))found.push([v,path.join(base,v,'bin','aos.mjs')]);",
  '}}',
  'found.sort((x,y)=>{const a=num(x[0]),b=num(y[0]);return a[0]-b[0]||a[1]-b[1]||a[2]-b[2];});',
  `if(!found.length)process.exit(${NOT_FOUND_EXIT});`,
  'aos=found[found.length-1][1];',
  '}',
  "const r=cp.spawnSync(process.execPath,[aos,...process.argv.slice(2)],{stdio:'inherit'});",
  'process.exit(r.status===null?1:r.status);',
].join('');

// Catalog texts are written into shell files: keep only what is safe inside a batch `echo` and a quoted sh string.
const safe = (s) => String(s).replace(/["%&|<>^!`$\\()]/g, '').replace(/\r?\n/g, ' ').trim();

// The one template: { cmd, sh } for one launcher, with its texts in the owner's language.
export function launcherText({ name, args, drop = false }, t, project = null) {
  const what = safe(t(`launcher.what.${name}`));
  const noNode = safe(t('launcher.no_node'));
  const noPlugin = safe(t('launcher.no_plugin'));
  const close = safe(t('launcher.close'));
  // ORD-0047 part 8: a launcher of an owner command carries the project it was written for; the command stops elsewhere.
  const line = [...args, ...(project && name !== 'ACTUALIZAR' ? ['--project', safe(project).split(' ').join('_')] : [])].join(' ');
  const cmd = [
    '@echo off',
    `rem Analucia: ${what} (aos ${line}). Written by aos launchers install.`,
    'chcp 65001 >nul',
    'cd /d "%~dp0"',
    'where node >nul 2>nul',
    'if errorlevel 1 goto nonode',
    `node -e "${RUNNER}" "%~dp0." ${line}${drop ? ' %*' : ''}`,
    `if %errorlevel%==${NOT_FOUND_EXIT} echo ${noPlugin}`,
    'goto end',
    ':nonode',
    `echo ${noNode}`,
    ':end',
    'echo.',
    'pause',
    '',
  ].join('\r\n');
  const sh = [
    '#!/bin/sh',
    `# Analucia: ${what} (aos ${line}). Written by aos launchers install.`,
    'cd "$(dirname "$0")" || exit 1',
    'if command -v node >/dev/null 2>&1; then',
    `  node -e "${RUNNER}" "$PWD" ${line}${drop ? ' "$@"' : ''}`,
    `  [ "$?" = "${NOT_FOUND_EXIT}" ] && echo "${noPlugin}"`,
    'else',
    `  echo "${noNode}"`,
    'fi',
    `printf '\\n%s ' "${close}"`,
    'read -r _',
    '',
  ].join('\n');
  return { cmd, sh };
}

// Writes the launchers in the project root. Idempotent: a second run reports every file unchanged.
// `only`: a list of launcher names (aos sign --install-launcher writes FIRMAR alone).
// ORD-0046 part 7 (OBS-194): one file per launcher, the one this system opens: .cmd on Windows, .sh elsewhere, so the
// owner sees one FIRMAR and not two.
export function installLaunchers(root, { only = LAUNCHER_NAMES, locale = personLocale(root), dryRun = false, platform = process.platform } = {}) {
  const t = catalog(locale);
  const written = [];
  for (const l of LAUNCHERS.filter((x) => only.includes(x.name))) {
    const text = launcherText(l, t, projectName(root));
    const files = platform === 'win32' ? [[`${l.name}.cmd`, text.cmd, 0o644]] : [[`${l.name}.sh`, text.sh, 0o755]];
    for (const [file, body, mode] of files) {
      const p = join(root, file);
      const status = !existsSync(p) ? 'created' : readFileSync(p, 'utf8') !== body ? 'updated' : 'unchanged';
      if (status !== 'unchanged' && !dryRun) writeFileSync(p, body, { mode });
      written.push({ name: l.name, file, status });
    }
  }
  return written;
}

// The launcher of `name` in `root` for this platform, or null when it was not installed.
export function launcherAt(root, name, platform = process.platform) {
  const file = launcherFile(name, platform);
  return existsSync(join(root, file)) ? file : null;
}
