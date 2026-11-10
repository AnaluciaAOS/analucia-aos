// ORD-0033 B.3 (finding D-3 of ORD-0031): one locale fallback for every line printed for a person — the SessionStart
// hook, aos init, aos init --check and the other CLI commands. Order: the --locale flag, the locale saved in the
// project, the system locale (LC_ALL, LC_MESSAGES, LANG, then the platform default), then en. Only supported locales.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOCALES } from './onboarding.mjs';

// A locale tag as a supported locale, or null: "es_PE.UTF-8" and "es-PE" → es, "zh_CN" → zh-Hans, "C" → null.
export function supportedLocale(tag) {
  if (typeof tag !== 'string' || !tag.trim()) return null;
  if (LOCALES.includes(tag)) return tag;
  const clean = tag.trim().split(/[.@]/)[0].replace('_', '-');
  if (!clean || /^(c|posix)$/i.test(clean)) return null;
  if (/^zh\b/i.test(clean)) return 'zh-Hans';
  const base = clean.split('-')[0].toLowerCase();
  return LOCALES.includes(base) ? base : null;
}

const platformLocale = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().locale ?? null; } catch { return null; }
};

// root: the project root, or null when there is no project. flag: the --locale value, if any.
export function personLocale(root, { flag, env = process.env, platform = platformLocale } = {}) {
  const fromFlag = supportedLocale(flag);
  if (fromFlag) return fromFlag;
  if (root) {
    try {
      const saved = supportedLocale(JSON.parse(readFileSync(join(root, '.analucia', 'project.json'), 'utf8')).locale);
      if (saved) return saved;
    } catch { /* no project file: the system locale decides */ }
  }
  for (const name of ['LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const l = supportedLocale(env[name]);
    if (l) return l;
  }
  return supportedLocale(platform()) ?? 'en';
}
