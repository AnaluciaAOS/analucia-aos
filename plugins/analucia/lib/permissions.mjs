// Permission profile (SPEC-0004 §3) and the plugin on its own repository (§7): `.claude/settings.json`.
// Rule syntax per the Claude Code permissions docs: Bash(cmd *) wildcards, Edit/Read gitignore-style paths
// ("/" = relative to the project root of a project settings file), precedence deny > ask > allow.
// Only the keys below are owned; every other key is kept. `.claude/settings.local.json` is never touched.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuleError } from './state.mjs';

export const SETTINGS_REL = '.claude/settings.json';

export const PROFILE = {
  allow: [
    'Edit(/**)',
    'Bash(node *)',
    'Bash(git status *)', 'Bash(git diff *)', 'Bash(git log *)', 'Bash(git show *)', 'Bash(git add *)', 'Bash(git commit *)',
    'Bash(git rev-parse *)', 'Bash(git ls-files *)', 'Bash(git check-ignore *)',
    'Bash(ls *)', 'Bash(cat *)', 'Bash(head *)', 'Bash(tail *)', 'Bash(wc *)', 'Bash(grep *)', 'Bash(pwd)', 'Bash(sha256sum *)',
  ],
  ask: ['Bash(git push *)'],
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
export function profileRules(profile = 'medium', extraDeny = []) {
  const high = profile === 'high';
  return {
    allow: high ? PROFILE.allow.filter((r) => r !== 'Edit(/**)') : PROFILE.allow,
    ask: high ? [...PROFILE.ask, 'Edit(//**)'] : PROFILE.ask,
    deny: [...PROFILE.deny, ...extraDeny.flatMap((p) => [`Read(${p})`, `Edit(${p})`])],
  };
}
// Every rule a profile can add: switching profile removes the old profile's rules instead of piling them up.
const OWNED = new Set([...PROFILE.allow, ...PROFILE.ask, ...PROFILE.deny, 'Edit(//**)']);

export function permissionsWrite(root, { marketplace = pluginMarketplace(), dryRun = false, profile = 'medium', extraDeny = [] } = {}) {
  const rules = profileRules(profile, extraDeny);
  const path = join(root, SETTINGS_REL);
  let settings = {};
  if (existsSync(path)) {
    try {
      settings = JSON.parse(readFileSync(path, 'utf8'));
    } catch (x) {
      throw new RuleError('E_JSON', `${SETTINGS_REL} is not valid JSON (${x.message}); fix it by hand, then run "aos permissions write" again`);
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
  return { path: SETTINGS_REL, changed, created: !existed, marketplace };
}
