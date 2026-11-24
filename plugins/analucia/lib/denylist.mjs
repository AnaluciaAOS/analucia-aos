// The list of forbidden names (ORD-0046 part 1, OBS-198): one reader of the list file and one matcher, used by the
// push guard (every added line of every pushed commit). Same format and same matching as scripts/release-guard.mjs:
// one term per line, "#" starts a comment, prefix "w:" = whole word, case-insensitive. The output of every caller
// names a rule by its position, never the word.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Parses the text of a list into [{ id, line, re }]; id = 1-based position among the rules, line = line in the file.
export function parseDenylist(text) {
  const rules = [];
  String(text).split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const whole = line.toLowerCase().startsWith('w:');
    const term = whole ? line.slice(2).trim() : line;
    if (!term) return;
    const body = escape(term);
    const pattern = whole ? `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])` : body;
    rules.push({ id: rules.length + 1, line: i + 1, re: new RegExp(pattern, 'iu') });
  });
  return rules;
}

// Reads a list file. Returns { rules } or { error } (missing, not a file, no terms): the caller fails closed.
export function loadDenylist(path) {
  if (!path || !existsSync(path) || !statSync(path).isFile()) return { error: 'the list of forbidden names is not there' };
  const rules = parseDenylist(readFileSync(path, 'utf8'));
  return rules.length ? { rules } : { error: 'the list of forbidden names has no terms' };
}

// The rules a text breaks.
export const matchingRules = (rules, text) => rules.filter(({ re }) => re.test(text));

// ORD-0047 part 13 (OBS-191): `aos admit` and `aos drafts` run the same matcher on the files of an order, tracked by
// git or not (a file not yet in git passed the push guard's view). `files` are paths relative to the project folder;
// one that does not exist is skipped. Returns { missing, hits }: `missing` names why a list that project.json names
// cannot be read (the caller fails closed); each hit is "<file>:<line> (rule <n>)", never the word.
export function scanFiles(root, project, files) {
  const key = project?.release_denylist;
  if (key === undefined || key === null) return { missing: null, hits: [] };
  const loaded = loadDenylist(typeof key === 'string' && key ? resolve(root, key) : '');
  if (loaded.error) return { missing: loaded.error, hits: [] };
  const hits = [];
  for (const file of files) {
    const abs = resolve(root, file);
    if (!existsSync(abs) || !statSync(abs).isFile()) continue;
    readFileSync(abs, 'utf8').split(/\r?\n/).forEach((text, i) => {
      for (const rule of matchingRules(loaded.rules, text)) hits.push(`${file}:${i + 1} (rule ${rule.id})`);
    });
  }
  return { missing: null, hits };
}
