// ORD-0047 part 14 (OBS-187): a spec that changes, changes its version. A core spec whose text differs from the one on
// `main` while its `version:` line is the same is an error of `aos validate` (E_SPEC_VERSION). Line endings do not
// count as a change. Where there is no git, no `main`, or the spec is not on `main`, nothing is judged.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const norm = (t) => String(t).replace(/\r\n/g, '\n');
export const versionOf = (text) => /^version:[ \t]*(\S+)/m.exec(norm(text))?.[1] ?? null;

function onMain(root, rel) {
  const r = spawnSync('git', ['-C', root, 'show', `refs/heads/main:${rel}`], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  return r.status === 0 ? r.stdout : null;
}

// [{ file, text }] for each core spec that changed with no new version.
export function specVersionProblems(root) {
  const dir = join(root, 'core');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter((n) => /^(NOMENCLATURE|SPEC-\d+.*)\.md$/.test(n)).sort()) {
    const rel = `core/${f}`;
    const base = onMain(root, rel);
    if (base === null) continue;
    const now = readFileSync(join(dir, f), 'utf8');
    if (norm(now) !== norm(base) && versionOf(now) === versionOf(base)) {
      out.push({ file: rel, code: 'E_SPEC_VERSION', text: `the text differs from the one on main but "version: ${versionOf(now)}" is the same: change the version line (a spec that changes, changes its version)` });
    }
  }
  return out;
}
