// Setup checks (SPEC-0005 §5): "ready" is proven, not declared. Each check is PASS, WARN or FAIL; every WARN and
// FAIL has a next (<who>) line. Stored credentials only (GIT_TERMINAL_PROMPT=0, 30 s for ls-remote).
// No check ever asks for or prints a secret: secret findings name the file, the line and the pattern.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { accountFixes, aosCommand, forceAccountCommand, githubSlug, installCommands, installFor, pluginInstall, renderCommands } from './cli.mjs';
import { secretPatterns, urlUser } from './guards.mjs';
import { appendEvent, isoWithOffset, projectTimeZone, readLog } from './log.mjs';
import { personLocale } from './locale.mjs';
import { LOCALES, catalog } from './onboarding.mjs';

const NO_PROMPT = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
const git = (root, args, opts = {}) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env: NO_PROMPT, ...opts });
const toPosix = (p) => p.split(sep).join('/');

// The real ls-remote; tests inject a stand-in so no test touches the network.
export function lsRemote(root) {
  const t0 = Date.now();
  const r = git(root, ['ls-remote', '--heads', 'origin'], { timeout: 30000 });
  return { ok: r.status === 0 && !r.error, ms: Date.now() - t0 };
}

function claudeFound() {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  if (existsSync(join(homedir(), '.local', 'bin', exe))) return true;
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8' });
  return which.status === 0;
}

const readJson = (p) => {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
};

// Commands for a next line, each alone on its own indented line, so it can be copied as is (ORD-0029 B).
const cmds = (list) => list.map((c) => `\n      ${c}`).join('');

// Working-tree files, skipping .git and node_modules (for .env discovery and the inventory).
function walk(root, dir = root, out = []) {
  for (const f of readdirSync(dir)) {
    if (f === '.git' || f === 'node_modules') continue;
    const p = join(dir, f);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(root, p, out);
    else out.push(toPosix(relative(root, p)));
  }
  return out;
}

export function runChecks(root, { lsRemote: ls = lsRemote, now = new Date(), install = pluginInstall() } = {}) {
  const results = [];
  const add = (name, status, detail, next) => results.push({ name, status, detail, ...(next ? { next } : {}) });
  const project = readJson(join(root, '.analucia', 'project.json')) ?? {};
  const onboarding = readJson(join(root, '.analucia', 'onboarding.json'));
  const isRepo = git(root, ['rev-parse', '--is-inside-work-tree']).stdout.trim() === 'true';
  const url = isRepo ? git(root, ['config', '--get', 'remote.origin.url']).stdout.trim() : '';
  const slug = githubSlug(url);
  const folder = basename(resolve(root));
  // "none" = the owner works without GitHub (wizard question 5); no command then names an account.
  const noGithub = project.github_owner === 'none';
  const owner = noGithub ? null : (project.github_owner ?? slug?.owner ?? null);
  const nameOwner = { who: 'owner', key: 'account.next_no_owner', vars: { cmds: cmds([`${aosCommand()} init`]) } };
  const later = (name) => add(name, 'WARN', { key: noGithub ? 'check.no_github' : 'check.later' }, { who: 'owner', key: noGithub ? 'check.next_no_github' : 'check.next_later' });

  // tools
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const gitVersion = spawnSync('git', ['--version'], { encoding: 'utf8' });
  const gitText = gitVersion.status === 0 ? gitVersion.stdout.trim() : '';
  if (nodeMajor < 20) add('tools', 'FAIL', { key: 'tools.no_node', vars: { node: process.versions.node } }, { who: 'owner', key: 'tools.next_node' });
  else if (!gitText) add('tools', 'FAIL', { key: 'tools.no_git' }, { who: 'owner', key: 'tools.next_git' });
  else if (!claudeFound()) add('tools', 'WARN', { key: 'tools.no_claude', vars: { node: process.versions.node, git: gitText } }, { who: 'owner', key: 'tools.next_claude' });
  else add('tools', 'PASS', { key: 'tools.ok', vars: { node: process.versions.node, git: gitText } });

  // repo
  // OBS-074: a copy without a remote (a ZIP download) is normal: one FAIL that says so, and the checks that need
  // the remote wait for it (WARN) instead of failing with it.
  if (isRepo && url) add('repo', 'PASS', { key: 'repo.ok', vars: { url: url.replace(/:[^@/]*@/, ':***@') } });
  else if (noGithub) add('repo', 'WARN', { key: 'check.no_github' }, { who: 'owner', key: 'check.next_no_github' });
  else if (!owner) add('repo', 'FAIL', { key: 'repo.fail' }, { who: 'owner', key: 'repo.next_no_owner', vars: { cmds: cmds([`${aosCommand()} init`]) } });
  else {
    const steps = [...(isRepo ? [] : ['git init']), `git remote add origin https://${owner}@github.com/${owner}/${folder}.git`];
    add('repo', 'FAIL', { key: 'repo.fail' }, { who: 'owner', key: 'repo.next', vars: { owner, repo: folder, cmds: cmds(steps) } });
  }

  // account (Q-90)
  const user = url ? urlUser(url) : null;
  const cred = isRepo ? git(root, ['config', '--get', 'credential.https://github.com.username']).stdout.trim() || null : null;
  const same = (v) => typeof v === 'string' && typeof project.github_owner === 'string' && v.toLowerCase() === project.github_owner.toLowerCase();
  if (!url) later('account');
  else if (same(user) && same(cred)) add('account', 'PASS', { key: 'account.ok', vars: { owner: project.github_owner } });
  else if (!project.github_owner || noGithub) add('account', 'FAIL', { key: 'account.fail', vars: { user: user ?? '—', cred: cred ?? '—', owner: '—' } }, nameOwner);
  else {
    // OBS-036, OBS-096, OBS-107: only the commands for what differs; a different credential user alone is one command.
    const fixes = accountFixes({ owner: project.github_owner, user, cred, url, folder });
    add('account', 'FAIL', { key: 'account.fail', vars: { user: user ?? '—', cred: cred ?? '—', owner: project.github_owner } }, { who: 'owner', key: 'account.next', vars: { cmds: cmds(fixes) } });
  }

  // remote_https
  if (!url) later('remote_https');
  else if (/^https:\/\//i.test(url)) add('remote_https', 'PASS', { key: 'remote_https.ok' });
  else {
    const as = owner ?? slug?.owner;
    const fix = slug && as ? `git remote set-url origin https://${as}@github.com/${slug.owner}/${slug.repo}.git` : null;
    add('remote_https', 'WARN', { key: 'remote_https.warn', vars: { url } }, fix ? { who: 'owner', key: 'remote_https.next', vars: { cmds: cmds([fix]) } } : nameOwner);
  }

  // reachable (stored credentials only)
  const reach = isRepo && url ? ls(root) : { ok: false, ms: 0 };
  if (!url) later('reachable');
  else if (reach.ok) add('reachable', 'PASS', { key: 'reachable.ok', vars: { ms: reach.ms } });
  else if (!owner) add('reachable', 'FAIL', { key: 'reachable.fail' }, nameOwner);
  else add('reachable', 'FAIL', { key: 'reachable.fail' }, { who: 'owner', key: 'reachable.next', vars: { owner, cmds: cmds([forceAccountCommand(owner, url, folder)]) } });

  // plugin_active
  let events = [];
  try { events = readLog(root).events; } catch { /* no log */ }
  const startup = events.filter((e) => e.type === 'role.declared' && e.payload?.source === 'startup').at(-1);
  // OBS-104: the install commands name the plugin's marketplace, never this project's repository. ORD-0029 A: Claude
  // Code loads a project-scope plugin only in the exact folder it was installed for (not in a subfolder of it).
  const where = installFor(root, install);
  const rootShown = resolve(root).split(sep).join('/');
  if (startup) add('plugin_active', 'PASS', { key: 'plugin_active.ok', vars: { ts: startup.ts } });
  else if (where.status === 'here' || where.status === 'user') add('plugin_active', 'WARN', { key: 'plugin_active.warn' }, { who: 'owner', key: 'plugin_active.next_here', vars: { root: rootShown } });
  else if (where.status === 'elsewhere') add('plugin_active', 'WARN', { key: 'plugin_active.warn' }, { who: 'owner', key: 'plugin_active.next_elsewhere', vars: { root: rootShown, count: where.count, cmds: cmds(installCommands(install)) } });
  else add('plugin_active', 'WARN', { key: 'plugin_active.warn' }, { who: 'owner', key: 'plugin_active.next', vars: { root: rootShown, cmds: cmds(installCommands(install)) } });

  // branch_protection (Q-98): not detectable without a token. With no remote at all (ORD-0033 B.4), it says so and
  // what to do: add a remote, then run the check again; the token wording stays for a repository that has one.
  if (!url) add('branch_protection', 'WARN', { key: 'branch_protection.no_remote' }, { who: 'owner', key: 'branch_protection.next_no_remote', vars: { cmds: cmds([`${aosCommand()} init --check`]) } });
  else add('branch_protection', 'WARN', { key: 'branch_protection.warn' }, { who: 'owner', key: 'branch_protection.next' });

  // cloud_access (Q-92): only when cloud sessions were asked for
  if (onboarding?.answers?.cloud_sessions?.value === 'yes') {
    const repo = slug ? `${slug.owner}/${slug.repo}` : owner ? `${owner}/${folder}` : folder;
    add('cloud_access', 'WARN', { key: 'cloud_access.warn', vars: { repo } }, { who: 'owner', key: 'cloud_access.next', vars: { repo } });
  }

  // secrets_tracked (Q-101): file and line, never the value
  const tracked = isRepo ? git(root, ['ls-files', '-z']).stdout.split('\0').filter(Boolean) : [];
  const patterns = secretPatterns();
  const hits = [];
  for (const f of tracked) {
    const p = join(root, f);
    let buf;
    try { buf = readFileSync(p); } catch { continue; }
    if (buf.length > 4 * 1024 * 1024 || buf.includes(0)) continue; // binary or huge
    buf.toString('utf8').split(/\r?\n/).forEach((line, i) => {
      for (const pat of patterns) if (pat.re.test(line)) hits.push(`${f}:${i + 1} (${pat.name})`);
    });
  }
  if (!hits.length) add('secrets_tracked', 'PASS', { key: 'secrets_tracked.ok', vars: { files: tracked.length } });
  else add('secrets_tracked', 'FAIL', { key: 'secrets_tracked.fail', vars: { count: hits.length, where: hits.join(', ') } }, { who: 'owner', key: 'secrets_tracked.next' });

  // env_ignored
  const files = walk(root);
  const envs = files.filter((f) => /(^|\/)\.env(\..+)?$/.test(f));
  const exposed = envs.filter((f) => git(root, ['check-ignore', '-q', f]).status !== 0);
  if (!exposed.length) add('env_ignored', 'PASS', { key: 'env_ignored.ok', vars: { count: envs.length } });
  else add('env_ignored', 'FAIL', { key: 'env_ignored.fail', vars: { files: exposed.join(', ') } }, { who: 'owner', key: 'env_ignored.next' });

  // inventory (Q-94): always PASS, recorded as observed
  const read = (f) => (existsSync(join(root, f)) ? readFileSync(join(root, f), 'utf8') : null);
  const claudeMd = read('CLAUDE.md');
  const agentsMd = read('AGENTS.md');
  const languages = {};
  for (const f of tracked.length ? tracked : files) {
    const ext = extname(f).slice(1).toLowerCase();
    if (ext) languages[ext] = (languages[ext] ?? 0) + 1;
  }
  const inventory = {
    operation: 'inventory', level: 'observed',
    readme: files.some((f) => /^readme(\.[a-z]+)?$/i.test(f)),
    manifests: files.filter((f) => /(^|\/)(package\.json|pyproject\.toml|requirements\.txt|go\.mod|Cargo\.toml|composer\.json|Gemfile|pom\.xml|build\.gradle)$/.test(f) && !f.includes('/fixtures/')).sort(),
    claude_md: { exists: claudeMd !== null, imports_agents: claudeMd?.split(/\r?\n/).some((l) => l.trim() === '@AGENTS.md') ?? false },
    agents_md: { exists: agentsMd !== null, analucia_block: agentsMd?.includes('<!-- analucia:begin -->') ?? false, foreign_blocks: (agentsMd?.match(/<!-- BEGIN:[^>]*-->/g) ?? []).length },
    orders: existsSync(join(root, '.analucia', 'orders')) ? readdirSync(join(root, '.analucia', 'orders')).filter((f) => f.endsWith('.md')).length : 0,
    commits: isRepo ? Number(git(root, ['rev-list', '--count', 'HEAD']).stdout.trim() || 0) : 0,
    languages: Object.fromEntries(Object.entries(languages).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 12)),
  };
  const summary = `${inventory.orders} orders, ${inventory.commits} commits, ${Object.entries(inventory.languages).slice(0, 5).map(([k, v]) => `${k} ${v}`).join(', ') || '—'}`;
  try {
    appendEvent(root, { type: 'operation.logged', actor: 'system', subject: null, payload: inventory }, { now });
  } catch { /* no log yet: the inventory is still reported */ }
  add('inventory', 'PASS', { key: 'inventory.ok', vars: { summary } });

  return { results, failed: results.some((r) => r.status === 'FAIL'), inventory };
}

export function reportText(results, locale = 'en', now = new Date(), timeZone) {
  const t = catalog(LOCALES.includes(locale) ? locale : 'en');
  const count = (s) => results.filter((r) => r.status === s).length;
  const out = [`${t('check.title')} — ${isoWithOffset(now, timeZone)}`, ''];
  for (const r of results) {
    out.push(`${r.status.padEnd(4)} ${r.name}: ${t(r.detail.key, r.detail.vars)}`);
    if (r.next) out.push(`  ${t('check.next', { who: r.next.who })}: ${renderCommands(t(r.next.key, r.next.vars))}`);
  }
  out.push('', t('check.summary', { pass: count('PASS'), warn: count('WARN'), fail: count('FAIL') }));
  return out.join('\n');
}

// aos init --check: run, print, save .analucia/views/onboarding.md. Returns the exit code (0 without FAIL).
export function initCheck(root, { out = () => {}, lsRemote: ls, now = new Date(), onDone = () => {}, locale = personLocale(root) } = {}) {
  const { results, failed } = runChecks(root, { lsRemote: ls, now });
  onDone(results);
  const text = reportText(results, locale, now, projectTimeZone(root));
  const dir = join(root, '.analucia', 'views');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'onboarding.md'), `${text}\n`);
  const t = catalog(LOCALES.includes(locale) ? locale : 'en');
  out(text);
  out(t('check.saved', { path: '.analucia/views/onboarding.md' }));
  return failed ? 1 : 0;
}
