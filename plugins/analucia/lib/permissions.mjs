// Permission profile (SPEC-0004 §3, inverted by ORD-0044 part 7) and the plugin on its own repository (§7): `.claude/settings.json`.
// Only the keys below are owned; every other key is kept. `.claude/settings.local.json` is written only by
// `aos permissions write --local` (ORD-0043 part 16, AMD-0017 section 2).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuleError } from './state.mjs';

export const SETTINGS_REL = '.claude/settings.json';
export const LOCAL_SETTINGS_REL = '.claude/settings.local.json';
export const DEFAULT_PROTECTED = ['main', 'master'];

// ORD-0044 part 7 (AMD-0023, OBS-193): everything is allowed, a short list of dangerous things is denied, and nothing
// asks: a session never waits for an approval. Rule syntax per the Claude Code permissions documentation
// (code.claude.com/docs/en/permissions, Claude Code 2.1.277): a bare tool name matches every use of that tool ("Bash",
// "PowerShell", "Edit", "Write"); "Bash(cmd *)" is a wildcard: "*" matches any text including spaces, and a trailing " *"
// also matches the bare command; Read/Edit paths follow gitignore syntax ("/" = project root, "//" = absolute); a Read
// deny also covers cat/head/tail/sed/tee of the same file in a command Claude Code can analyze. Precedence, as the docs
// say: "Rules are evaluated in order: deny, then ask, then allow. The first match in that order determines the outcome."
// So deny wins over allow.
const both = (list) => list.flatMap((c) => [`Bash(${c})`, `PowerShell(${c})`]);
const SECRET_GLOBS = ['*.env', '*.env.*', '*.pem', '*.key'];
const READERS = ['cat', 'type', 'Get-Content', 'gc', 'head', 'tail', 'more', 'less'];

export const DENY_FORCE_PUSH = both(['git push --force *', 'git push * --force*', 'git push -f *', 'git push * -f*', 'git push * +*']);
export const DENY_RESET_HARD = both(['git reset --hard *']);
export const DENY_MASS_DELETE = both([
  'rm -rf *', 'rm -fr *', 'rm -r *', 'rm -R *', 'rm -fR *', 'rm --recursive *',
  'Remove-Item * -Recurse*', 'Remove-Item -Recurse*', 'ri * -Recurse*', 'rd /s *', 'rmdir /s *', 'del /s *',
  'cmd /c del /s *', 'cmd /c rmdir /s *', 'cmd /c rd /s *',
]);
export const DENY_SECRETS = [
  'Read(**/.env)', 'Read(**/.env.*)', 'Read(**/*.pem)', 'Read(**/*.key)',
  ...both(READERS.flatMap((c) => SECRET_GLOBS.map((g) => `${c} ${g}`))),
];
const PREFIXES = ['', 'npx ', 'pnpm ', 'pnpm dlx ', 'yarn ', 'bunx '];
export const DENY_DATABASE = both([
  'psql *', 'pg_restore *', 'mysql *', 'mariadb *', 'mongosh *', 'mongorestore *', 'sqlcmd *',
  ...PREFIXES.flatMap((p) => [
    `${p}prisma migrate *`, `${p}prisma db push*`, `${p}prisma db execute*`, `${p}drizzle-kit push*`, `${p}drizzle-kit migrate*`,
    `${p}knex migrate:*`, `${p}sequelize db:migrate*`, `${p}typeorm migration:run*`, `${p}supabase db push*`, `${p}supabase db reset*`,
  ]),
  'alembic upgrade *', 'flask db upgrade*', 'rails db:migrate*', 'rake db:migrate*', 'php artisan migrate*', 'python manage.py migrate*',
]);
// A push to a protected branch, in every form the rules can match: by name, src:dst, HEAD:main, refs/heads/main.
export const pushDeny = (protectedBranches = DEFAULT_PROTECTED) => both(protectedBranches.flatMap((b) => [
  `git push * ${b}`, `git push * ${b} *`, `git push * *:${b}`, `git push * *:${b} *`, `git push * refs/heads/${b}`, `git push * *:refs/heads/${b}`, `git push * HEAD:${b}`,
]));

export const PROFILE = {
  allow: ['Bash', 'PowerShell', 'Edit', 'Write'],
  ask: [],
  deny: [...DENY_FORCE_PUSH, ...DENY_RESET_HARD, ...DENY_MASS_DELETE, ...DENY_SECRETS, ...DENY_DATABASE],
};

// The rules of the earlier profiles (ORD-0043 part 16, ORD-0044 part 4): writing the profile removes them.
const LEGACY = [
  'Edit(/**)', 'Bash(node *)', 'Bash(git status *)', 'Bash(git diff *)', 'Bash(git log *)', 'Bash(git show *)', 'Bash(git add *)', 'Bash(git commit *)',
  'Bash(git rev-parse *)', 'Bash(git ls-files *)', 'Bash(git check-ignore *)', 'Bash(ls *)', 'Bash(cat *)', 'Bash(head *)', 'Bash(tail *)', 'Bash(wc *)',
  'Bash(grep *)', 'Bash(pwd)', 'Bash(sha256sum *)', 'Bash(git push origin *)', 'Bash(git push -u origin *)', 'Bash(git push --set-upstream origin *)',
  'Bash(git push)', 'Bash(git push origin)', 'Bash(git push -u origin)', 'Bash(git push --set-upstream origin)', 'Bash(git push origin -*)', 'Bash(git push *)', 'Edit(//**)',
  ...['main', 'master'].flatMap((b) => [`Bash(git push * ${b})`, `Bash(git push * ${b} *)`, `Bash(git push * *:${b})`, `Bash(git push * *:${b} *)`, `Bash(git push * refs/heads/${b})`, `Bash(git push * *:refs/heads/${b})`]),
];

const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url));

// The marketplace this plugin ships in: its name from .claude-plugin/marketplace.json and its GitHub repo from git.
export function pluginMarketplace() {
  const repoRoot = join(PLUGIN_ROOT, '..', '..');
  const mp = join(repoRoot, '.claude-plugin', 'marketplace.json');
  if (!existsSync(mp)) return null;
  const { name, plugins = [] } = JSON.parse(readFileSync(mp, 'utf8'));
  const plugin = plugins.find((p) => /plugins\/analucia\/?$/.test(p.source ?? ''))?.name ?? 'analucia';
  const url = spawnSync('git', ['-C', repoRoot, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).stdout.trim();
  const repo = /github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/.exec(url)?.[1] ?? null;
  return repo ? { name, plugin, repo } : null;
}

const merge = (current = [], owned = []) => [...current.filter((r) => !owned.includes(r)), ...owned];

// The key order Claude Code itself writes (ORD-0011): permissions { allow, deny, ask, … }, enabledPlugins,
// extraKnownMarketplaces, then any other key in its existing order. A session start then leaves the file unchanged.
const pick = (obj, first) => {
  const out = {};
  for (const k of first) if (k in obj) out[k] = obj[k];
  for (const k of Object.keys(obj)) if (!(k in out)) out[k] = obj[k];
  return out;
};
export const ordered = (settings) => {
  const s = pick(settings, ['permissions', 'enabledPlugins', 'extraKnownMarketplaces']);
  if (s.permissions) s.permissions = pick(s.permissions, ['allow', 'deny', 'ask']);
  return s;
};

// One profile for every risk level (the order's risk and the push guard stay; the permissions no longer change with
// it). extraDeny: never_leaves paths. protectedBranches: a push to one of them is denied.
export function profileRules(_profile = 'medium', extraDeny = [], protectedBranches = DEFAULT_PROTECTED) {
  return {
    allow: [...PROFILE.allow],
    ask: [],
    deny: [...PROFILE.deny, ...pushDeny(protectedBranches), ...extraDeny.flatMap((p) => [`Read(${p})`, `Edit(${p})`])],
  };
}
// Every rule a profile can add: writing the profile removes the old profiles' rules instead of piling them up.
const OWNED = new Set([...PROFILE.allow, ...PROFILE.deny, ...pushDeny(), ...LEGACY]);

// The protected branches of the project: `protected_branches` of project.json; main and master when the key is absent.
export function protectedBranches(root) {
  try {
    const p = JSON.parse(readFileSync(join(root, '.analucia', 'project.json'), 'utf8'));
    if (Array.isArray(p.protected_branches) && p.protected_branches.every((b) => typeof b === 'string')) return p.protected_branches;
  } catch { /* no project file: the defaults */ }
  return DEFAULT_PROTECTED;
}

// local: write `.claude/settings.local.json` (git ignores it) with the permission rules only: no plugin or marketplace key.
// Only the `permissions` key is changed; the ask list is always empty (nothing asks).
export function permissionsWrite(root, { marketplace = pluginMarketplace(), dryRun = false, profile = 'medium', extraDeny = [], local = false } = {}) {
  const rules = profileRules(profile, extraDeny, protectedBranches(root));
  const rel = local ? LOCAL_SETTINGS_REL : SETTINGS_REL;
  if (local) marketplace = null;
  const path = join(root, rel);
  let settings = {};
  if (existsSync(path)) {
    try {
      settings = JSON.parse(readFileSync(path, 'utf8'));
    } catch (x) {
      throw new RuleError('E_JSON', `${rel} is not valid JSON (${x.message}); fix it by hand, then run "aos permissions write" again`);
    }
  }
  const p = settings.permissions ?? {};
  const before = { allow: [...(p.allow ?? [])], deny: [...(p.deny ?? [])], ask: [...(p.ask ?? [])] };
  const foreign = (list = []) => list.filter((r) => !OWNED.has(r));
  settings.permissions = {
    ...p, allow: merge(foreign(p.allow), rules.allow), ask: [], deny: merge(foreign(p.deny), rules.deny),
  };
  // Deny wins over allow in Claude Code; still, the profile's allow list never repeats a denied rule.
  settings.permissions.allow = settings.permissions.allow.filter((r) => !rules.deny.includes(r));
  if (marketplace) {
    // §7: the documented project-level plugin settings (extraKnownMarketplaces + enabledPlugins).
    settings.extraKnownMarketplaces = { ...(settings.extraKnownMarketplaces ?? {}), [marketplace.name]: { source: { source: 'github', repo: marketplace.repo } } };
    settings.enabledPlugins = { ...(settings.enabledPlugins ?? {}), [`${marketplace.plugin}@${marketplace.name}`]: true };
  }
  const text = `${JSON.stringify(ordered(settings), null, 2)}\n`;
  const existed = existsSync(path);
  const changed = !existed || readFileSync(path, 'utf8') !== text;
  if (changed && !dryRun) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  const after = { allow: settings.permissions.allow, deny: settings.permissions.deny, ask: settings.permissions.ask };
  return { path: rel, changed, created: !existed, marketplace, before, after };
}

// ORD-0046 part 4 (PERMISOS, decision 2: A): what writing the profile would change, file by file, without writing.
// The versioned file (permissions only, as `aos permissions write --permissions-only`) and the local one
// (`--local`). Each entry: { path, changed, counts: { allow, deny, ask }, added: { allow, deny, ask }, removed: {...} }.
export function permissionsPlan(root) {
  const KINDS = ['allow', 'deny', 'ask'];
  return [permissionsWrite(root, { marketplace: null, dryRun: true }), permissionsWrite(root, { local: true, dryRun: true })].map((r) => ({
    path: r.path,
    changed: r.changed,
    counts: Object.fromEntries(KINDS.map((k) => [k, r.after[k].length])),
    added: Object.fromEntries(KINDS.map((k) => [k, r.after[k].filter((x) => !r.before[k].includes(x))])),
    removed: Object.fromEntries(KINDS.map((k) => [k, r.before[k].filter((x) => !r.after[k].includes(x))])),
  }));
}

const shortList = (rules, max = 6) => (rules.length > max ? `${rules.slice(0, max).join(', ')} +${rules.length - max}` : rules.join(', '));

// The owner-only button. Shows in plain words what will change, asks for a typed word, then writes both files with
// the same function as `aos permissions write`. Nothing is written without the word or without a terminal.
// ask(question) -> the typed line; out(line); t: the owner's catalog. Returns { written: [paths], cancelled }.
export const APPLY_WORD = 'APLICAR';
export async function permissionsApply(root, { isTTY, ask, out, t }) {
  if (!isTTY) throw new RuleError('E_OWNER_TTY', 'changing the permission files is a task of the owner: press PERMISOS in the project folder, or run "aos permissions apply" in your own interactive terminal; stdin is not a TTY, so an agent cannot do it');
  const plan = permissionsPlan(root);
  if (!plan.some((f) => f.changed)) {
    out(t('perm.nothing'));
    return { written: [], cancelled: false };
  }
  out(t('perm.intro'));
  for (const f of plan) {
    out(t('perm.file', { file: f.path, allow: f.counts.allow, deny: f.counts.deny, ask: f.counts.ask }));
    const add = [...f.added.allow, ...f.added.deny, ...f.added.ask];
    const rem = [...f.removed.allow, ...f.removed.deny, ...f.removed.ask];
    if (!f.changed) out(t('perm.same'));
    if (add.length) out(t('perm.added', { n: add.length, list: shortList(add) }));
    if (rem.length) out(t('perm.removed', { n: rem.length, list: shortList(rem) }));
  }
  const word = String(await ask(t('perm.ask_word', { word: APPLY_WORD }))).trim();
  if (word !== APPLY_WORD) {
    out(t('perm.cancelled'));
    return { written: [], cancelled: true };
  }
  const written = [permissionsWrite(root, { marketplace: null }), permissionsWrite(root, { local: true })].filter((r) => r.changed).map((r) => r.path);
  return { written, cancelled: false };
}
