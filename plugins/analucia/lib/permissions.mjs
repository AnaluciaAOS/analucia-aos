// Permission profile (SPEC-0004 §3) and the plugin on its own repository (§7): `.claude/settings.json`.
// Rule syntax per the Claude Code permissions docs: Bash(cmd *) wildcards, Edit/Read gitignore-style paths
// ("/" = relative to the project root of a project settings file), precedence deny > ask > allow.
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

export const PROFILE = {
  allow: [
    'Edit(/**)',
    'Bash(node *)',
    'Bash(git status *)', 'Bash(git diff *)', 'Bash(git log *)', 'Bash(git show *)', 'Bash(git add *)', 'Bash(git commit *)',
    'Bash(git rev-parse *)', 'Bash(git ls-files *)', 'Bash(git check-ignore *)',
    'Bash(ls *)', 'Bash(cat *)', 'Bash(head *)', 'Bash(tail *)', 'Bash(wc *)', 'Bash(grep *)', 'Bash(pwd)', 'Bash(sha256sum *)',
  ],
  // ORD-0043 part 16 (OBS-177): a push that names a branch that is not protected does not ask; a push that names a
  // protected branch, or names no branch, asks. Rule shapes (Claude Code permissions docs): precedence deny > ask >
  // allow; a "*" may stand anywhere; a trailing " *" also matches the bare command. So the broad rule is an allow
  // for `git push origin *` / `git push -u origin *`, and ask rules (which beat it) cover the bare forms and each
  // protected branch (see pushAsk). Force pushes stay denied. The old profile asked for every push (`Bash(git push *)`).
  ask: [],
  deny: [
    'Bash(git push --force *)', 'Bash(git push * --force*)', 'Bash(git push -f *)', 'Bash(git push * -f*)',
    'Bash(git reset --hard *)', 'Bash(rm -rf *)', 'Bash(rm -fr *)',
    'Read(**/.env)', 'Read(**/.env.*)', 'Read(**/*.pem)', 'Read(**/*.key)',
  ],
};

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

// The push rules of part 16 for the protected branches given. `ask` beats `allow`: the bare forms and every form that
// names a protected branch (alone, as src:dst, or as refs/heads/<b>) ask; any other branch of origin is allowed.
export const PUSH_ALLOW = ['Bash(git push origin *)', 'Bash(git push -u origin *)', 'Bash(git push --set-upstream origin *)'];
export const pushAsk = (protectedBranches = DEFAULT_PROTECTED) => [
  'Bash(git push)', 'Bash(git push origin)', 'Bash(git push -u origin)', 'Bash(git push --set-upstream origin)', 'Bash(git push origin -*)',
  ...protectedBranches.flatMap((b) => [`Bash(git push * ${b})`, `Bash(git push * ${b} *)`, `Bash(git push * *:${b})`, `Bash(git push * *:${b} *)`, `Bash(git push * refs/heads/${b})`, `Bash(git push * *:refs/heads/${b})`]),
];
const LEGACY_ASK = 'Bash(git push *)';

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

// profile 'low' | 'medium' | 'high' (SPEC-0005 §4: chosen by risk_default). low and medium are the SPEC-0004 §3
// profile; high also asks before every edit (a superset of "ask for any write outside the repo", which the
// documented rule syntax cannot express without an unverified negation). extraDeny: never_leaves paths.
export function profileRules(profile = 'medium', extraDeny = [], protectedBranches = DEFAULT_PROTECTED) {
  const high = profile === 'high';
  return {
    allow: [...(high ? PROFILE.allow.filter((r) => r !== 'Edit(/**)') : PROFILE.allow), ...(high ? [] : PUSH_ALLOW)],
    // high keeps asking for every push, as before.
    ask: high ? [LEGACY_ASK, 'Edit(//**)'] : pushAsk(protectedBranches),
    deny: [...PROFILE.deny, ...extraDeny.flatMap((p) => [`Read(${p})`, `Edit(${p})`])],
  };
}
// Every rule a profile can add: switching profile removes the old profile's rules instead of piling them up.
const OWNED = new Set([...PROFILE.allow, ...PUSH_ALLOW, ...pushAsk(), LEGACY_ASK, ...PROFILE.deny, 'Edit(//**)']);

// The protected branches of the project: `protected_branches` of project.json; main and master when the key is absent.
export function protectedBranches(root) {
  try {
    const p = JSON.parse(readFileSync(join(root, '.analucia', 'project.json'), 'utf8'));
    if (Array.isArray(p.protected_branches) && p.protected_branches.every((b) => typeof b === 'string')) return p.protected_branches;
  } catch { /* no project file: the defaults */ }
  return DEFAULT_PROTECTED;
}

// local: write `.claude/settings.local.json` (git ignores it) with the permission rules only: no plugin or marketplace key.
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
  const foreign = (list = []) => list.filter((r) => !OWNED.has(r));
  settings.permissions = {
    ...p, allow: merge(foreign(p.allow), rules.allow), ask: merge(foreign(p.ask), rules.ask), deny: merge(foreign(p.deny), rules.deny),
  };
  // The profile's allow rules must not also allow what it asks about or denies.
  settings.permissions.allow = settings.permissions.allow.filter((r) => !rules.ask.includes(r) && !rules.deny.includes(r));
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
  return { path: rel, changed, created: !existed, marketplace };
}
