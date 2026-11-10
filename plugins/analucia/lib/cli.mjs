// ORD-0029 B: every command the tools print is one the user can paste on their own machine, as is, on one line.
// `aos` is not on the PATH and plugins/analucia/ exists only in the plugin's own repository, so printed commands
// use the absolute path of this installed copy of the CLI. Marketplace and install commands name the plugin's
// own marketplace (never the project's repository) by its full HTTPS address (SSH needs a GitHub key).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const posix = (p) => p.split(sep).join('/');
export const PLUGIN_DIR = posix(fileURLToPath(new URL('../', import.meta.url))).replace(/\/$/, '');
export const AOS_BIN = `${PLUGIN_DIR}/bin/aos.mjs`;
export const PLUGIN = 'analucia';
export const MARKETPLACE = { name: 'analucia-aos', url: 'https://github.com/AnaluciaAOS/analucia-aos.git' };

// The command that runs aos here: node "<absolute path>/bin/aos.mjs" (quoted: Windows user folders may hold spaces).
export const aosCommand = () => `node "${AOS_BIN}"`;

// The aos subcommands (bin/aos.mjs), so prose like "run aos validate" can be turned into a command that exists.
export const SUBCOMMANDS = ['backup', 'review', 'workflow', 'pause', 'resume-order', 'sign', 'metrics', 'adopt', 'eval', 'init', 'permissions',
  'role', 'ask', 'ceo', 'admit', 'cost', 'explain', 'validate', 'event', 'verify-log', 'derive', 'history', 'run', 'verify', 'close', 'halt',
  'resume', 'check-writeback', 'hook', 'agents-md', 'check-roles', 'check-push', 'install-git-hooks'];
const SUB = [...SUBCOMMANDS].sort((a, b) => b.length - a.length).join('|');
const COMMAND_RE = new RegExp(`node plugins/analucia/bin/aos\\.mjs|\\{aos\\}|(?<![\\w/.-])aos (?=(?:${SUB})\\b)|plugins/analucia/(core|lib|docs|templates)/`, 'g');

// Rewrites repo-only command forms into the real ones for this machine; everything else is left as written.
export function renderCommands(text) {
  return String(text).replace(COMMAND_RE, (m, dir) => (dir ? `${PLUGIN_DIR}/${dir}/` : m.startsWith('aos ') ? `${aosCommand()} ` : aosCommand()));
}

// owner/repo of a GitHub remote URL (HTTPS or SSH), or null.
export function githubSlug(url) {
  const m = /github\.com[/:]([A-Za-z0-9-]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url ?? '');
  return m ? { owner: m[1], repo: m[2] } : null;
}

// The commands that bind this repository to github_owner, only for what differs, one per line (OBS-036, OBS-096).
// The URL user picks the account the credential manager uses; the credential username is the one stored setting.
export function accountFixes({ owner, user, cred, url, remote = 'origin', folder }) {
  const same = (v) => typeof v === 'string' && v.toLowerCase() === owner.toLowerCase();
  const slug = githubSlug(url) ?? { owner, repo: folder };
  const out = [];
  if (!same(user)) out.push(`git remote set-url ${remote} https://${owner}@github.com/${slug.owner}/${slug.repo}.git`);
  if (!same(cred)) out.push(`git config credential.https://github.com.username ${owner}`);
  return out;
}

// One line that reaches the remote as github_owner even when the machine stores another GitHub sign-in (OBS-097).
export const forceAccountCommand = (owner, url, folder) => {
  const slug = githubSlug(url) ?? { owner, repo: folder };
  return `git -c credential.https://github.com.username=${owner} ls-remote https://${owner}@github.com/${slug.owner}/${slug.repo}.git`;
};

// Claude Code's configuration folder: CLAUDE_CONFIG_DIR when it is set, else .claude in the home folder (ORD-0033 B.1).
export function claudeConfigDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.trim() ? resolve(env.CLAUDE_CONFIG_DIR) : join(homedir(), '.claude');
}

// What Claude Code knows about this plugin on this machine (installed_plugins.json, known_marketplaces.json).
export function pluginInstall(configDir = claudeConfigDir()) {
  const read = (f) => {
    try { return JSON.parse(readFileSync(join(configDir, 'plugins', f), 'utf8')); } catch { return null; }
  };
  const entries = read('installed_plugins.json')?.plugins?.[`${PLUGIN}@${MARKETPLACE.name}`] ?? [];
  const known = read('known_marketplaces.json');
  return { entries: Array.isArray(entries) ? entries : [], marketplaceKnown: Boolean(known && known[MARKETPLACE.name]) };
}

const samePath = (a, b) => {
  const n = (p) => posix(resolve(p)).replace(/\/$/, '');
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};

// How the plugin stands for the project root: user scope, project scope for this folder, another folder, or none.
// "elsewhere" carries a count only: another project's path is never printed (ORD-0033 B.1).
export function installFor(root, install = pluginInstall()) {
  if (install.entries.some((e) => e.scope === 'user')) return { status: 'user' };
  const project = install.entries.filter((e) => e.scope === 'project' || e.scope === 'local');
  if (project.some((e) => e.projectPath && samePath(e.projectPath, root))) return { status: 'here' };
  if (project.length) return { status: 'elsewhere', count: new Set(project.map((e) => posix(resolve(e.projectPath ?? '?')))).size };
  return { status: 'none' };
}

// The commands that install the plugin for this folder, one per line (the marketplace line only when it is unknown).
export function installCommands(install = pluginInstall()) {
  const lines = [];
  if (!install.marketplaceKnown) lines.push(`claude plugin marketplace add ${MARKETPLACE.url}`);
  lines.push(`claude plugin install ${PLUGIN}@${MARKETPLACE.name} --scope project`);
  return lines;
}
