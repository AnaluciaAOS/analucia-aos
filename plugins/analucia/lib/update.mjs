// ORD-0043 part 7: the plugin is updated without the owner. `aos update` updates the marketplace the installed plugin
// came from and then the plugin, in every scope where it is installed, through the `claude` command-line tool only:
// it never edits a file of the configuration folder. The tool honours CLAUDE_CONFIG_DIR by itself (the environment is
// passed on as it is). And one warning, computed without the network: the installed plugin is older than the newest
// version this machine can see (the marketplace copy next to the installation; the plugin source a project carries).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve, sep } from 'node:path';
import { PLUGIN, PLUGIN_DIR, claudeConfigDir } from './cli.mjs';

// The two marketplaces: the public tree keeps the first name, the private repository has its own.
export const PUBLIC_MARKETPLACE = 'analucia-aos';
export const PRIVATE_MARKETPLACE = 'analucia-aos-private';

const num = (v) => String(v).split('.').map(Number);
const isVersion = (v) => /^\d+\.\d+\.\d+$/.test(String(v ?? ''));
export const compareVersions = (x, y) => { const a = num(x), b = num(y); return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]; };
const newest = (list) => list.filter(isVersion).sort(compareVersions).at(-1) ?? null;

// The `claude` command-line tool: on the PATH first, then in its usual places. null when it is not found.
export function findClaude(env = process.env, platform = process.platform) {
  const names = platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude.bat'] : ['claude'];
  const home = env.USERPROFILE || env.HOME || homedir();
  const dirs = [
    ...String(env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean),
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    ...(platform === 'win32' && env.APPDATA ? [join(env.APPDATA, 'npm')] : ['/usr/local/bin', '/opt/homebrew/bin']),
  ];
  for (const d of dirs) for (const n of names) if (existsSync(join(d, n))) return join(d, n);
  return null;
}

// Runs the tool without a terminal: it can never wait for an answer.
function runClaude(bin, args, { env, cwd } = {}) {
  const viaShell = /\.(cmd|bat)$/i.test(bin);
  const r = viaShell
    ? spawnSync(`"${bin}" ${args.map((a) => (/^[\w@.:=/\\-]+$/.test(a) ? a : `"${a}"`)).join(' ')}`, { encoding: 'utf8', env, cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    : spawnSync(bin, args, { encoding: 'utf8', env, cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  return { status: r.status === null ? 1 : r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const SIGN_IN = /\b(log ?in|sign ?in|not authenticated|authenticat(e|ion) (required|failed)|unauthori[sz]ed|credentials?)\b/i;

// The installations of this plugin the tool reports: [{ id, marketplace, scope, version, projectPath }].
function installations(bin, opts) {
  const r = runClaude(bin, ['plugin', 'list', '--json'], opts);
  if (r.status !== 0) return { error: r };
  let list;
  try { list = JSON.parse(r.stdout); } catch { return { error: r }; }
  const rows = (Array.isArray(list) ? list : []).filter((p) => typeof p?.id === 'string' && p.id.startsWith(`${PLUGIN}@`)).map((p) => ({
    id: p.id, marketplace: p.id.slice(PLUGIN.length + 1), scope: p.scope ?? 'user', version: p.version ?? '?', projectPath: p.projectPath ?? null,
  }));
  return { rows };
}

// Returns { ok, reason, rows: [{ id, scope, before, after }], detail }. reason: not_found | sign_in | not_installed |
// failed | null. On every reason but null nothing was changed by this command.
export function update({ env = process.env, cwd = process.cwd() } = {}) {
  const bin = findClaude(env);
  if (!bin) return { ok: false, reason: 'not_found', rows: [] };
  const opts = { env, cwd };
  const refusal = (r) => ({ ok: false, reason: SIGN_IN.test(`${r.stdout}\n${r.stderr}`) ? 'sign_in' : 'failed', rows: [], detail: `${r.stderr || r.stdout}`.trim().split(/\r?\n/).at(-1) ?? '' });
  const before = installations(bin, opts);
  if (before.error) return refusal(before.error);
  if (!before.rows.length) return { ok: false, reason: 'not_installed', rows: [] };
  for (const m of [...new Set(before.rows.map((r) => r.marketplace))]) {
    const r = runClaude(bin, ['plugin', 'marketplace', 'update', m], opts);
    if (r.status !== 0) return refusal(r);
  }
  for (const row of before.rows) {
    // A project or local installation is updated from its own folder.
    const at = row.projectPath && existsSync(row.projectPath) ? row.projectPath : cwd;
    const r = runClaude(bin, ['plugin', 'update', row.id, '--scope', row.scope], { env, cwd: at });
    if (r.status !== 0) return { ...refusal(r), rows: before.rows.map((b) => ({ id: b.id, scope: b.scope, before: b.version, after: b.version })) };
  }
  const after = installations(bin, opts);
  if (after.error) return refusal(after.error);
  const key = (r) => `${r.id}\0${r.scope}\0${r.projectPath ?? ''}`;
  const now = new Map(after.rows.map((r) => [key(r), r.version]));
  return { ok: true, reason: null, rows: before.rows.map((b) => ({ id: b.id, scope: b.scope, before: b.version, after: now.get(key(b)) ?? b.version })) };
}

const versionAt = (pluginDir) => {
  try { return JSON.parse(readFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8')).version ?? null; } catch { return null; }
};
const posix = (p) => resolve(p).split(sep).join('/');
const fold = (p) => (process.platform === 'win32' ? posix(p).toLowerCase() : posix(p));

// { installed, newest } when the installed plugin is older than the newest version visible without the network, else
// null. Installed: this copy when it runs from the plugin cache, else the newest copy in the cache of the
// configuration folder. Visible: the marketplace copy next to that installation, and the plugin source of `root`.
export function updateWarning(root, { env = process.env, pluginDir = PLUGIN_DIR } = {}) {
  const cfg = claudeConfigDir(env);
  const cache = join(cfg, 'plugins', 'cache');
  const inCache = fold(pluginDir).startsWith(`${fold(cache)}/`);
  const markets = existsSync(cache) ? readdirSync(cache).filter((m) => existsSync(join(cache, m, PLUGIN))) : [];
  const cached = markets.flatMap((m) => readdirSync(join(cache, m, PLUGIN)).filter((v) => existsSync(join(cache, m, PLUGIN, v, 'bin', 'aos.mjs'))));
  const installed = inCache ? versionAt(pluginDir) : newest(cached);
  if (!isVersion(installed)) return null;
  const own = inCache ? [fold(pluginDir).slice(fold(cache).length + 1).split('/')[0]] : markets;
  const visible = markets.filter((m) => own.includes(m.toLowerCase()) || own.includes(m)).map((m) => versionAt(join(cfg, 'plugins', 'marketplaces', m, 'plugins', PLUGIN)));
  if (root) visible.push(versionAt(join(root, 'plugins', PLUGIN)));
  const top = newest(visible);
  return top && compareVersions(installed, top) < 0 ? { installed, newest: top } : null;
}
