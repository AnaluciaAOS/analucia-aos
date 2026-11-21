// ORD-0043 part 14 (OBS-171): facts of git. `aos tracked <path>…` says, for each path, from `git ls-files` and
// `git check-ignore`, whether it is under version control, ignored (by which rule of which file) or neither. A file
// that is tracked is under version control even when an ignore rule matches it (git keeps tracking it).
import { spawnSync } from 'node:child_process';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { RuleError } from './state.mjs';

const git = (root, args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });

export function tracked(root, paths) {
  const top = git(root, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) throw new RuleError('E_FILE_MISSING', `${root} is not inside a git repository, so nothing can be said about version control`);
  return paths.map((given) => {
    const abs = isAbsolute(given) ? given : resolve(process.cwd() === resolve(root) ? root : root, given);
    const rel = relative(resolve(root), abs).split(sep).join('/') || given;
    if (git(root, ['ls-files', '--error-unmatch', '--', rel]).status === 0) return { path: given, state: 'tracked' };
    // --no-index: judge the rule even for a path git already knows; -v: which rule of which file and line.
    const ignored = git(root, ['check-ignore', '-v', '--no-index', '--', rel]);
    const m = ignored.status === 0 ? /^(.*?):(\d+):([^\t]*)\t/.exec(ignored.stdout) : null;
    if (m) return { path: given, state: 'ignored', file: m[1].split('\\').join('/'), line: Number(m[2]), rule: m[3] };
    return { path: given, state: 'neither' };
  });
}

export const trackedLine = (r) => (r.state === 'tracked' ? `${r.path}: under version control`
  : r.state === 'ignored' ? `${r.path}: ignored by the rule "${r.rule}" of ${r.file}:${r.line}`
    : `${r.path}: neither (not under version control and not ignored)`);
