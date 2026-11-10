// ORD-0034: a verify check may never depend on a moving ref.
// A check that ends a git diff/log range at HEAD, a branch or a remote ref starts failing as soon as later
// work moves that ref (ORD-0028 check 11, AMD-0008). `aos validate` flags such a check (E_MOVING_REF) and
// `aos verify` resolves the fixed placeholder {order_commit} (E_NO_ORDER_COMMIT when there is none).
//
// Scope of the rule (director design note on ORD-0034): only the END of a range that is meant to be fixed is
// checked: the right side of A..B / A...B (an empty right side means HEAD) in diff, log, rev-list and the other
// range commands, and the last of two or more revisions of git diff / git diff-tree. Single revisions are
// accepted: `--ref HEAD` (build the current tree), `git merge-base --is-ancestor <sha> HEAD` (stays true while
// history is not rewritten), `git rev-parse --verify <ref>` and `git log --grep …`.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const ORDER_COMMIT = '{order_commit}';
// Orders admitted with pins.plugin at or above this version get an error; older admitted orders a warning.
export const MOVING_REF_SINCE = '0.3.0';

const RANGE_CMDS = new Set(['diff', 'diff-tree', 'log', 'rev-list', 'shortlog', 'whatchanged', 'cherry', 'range-diff', 'format-patch']);
const TWO_POINT_CMDS = new Set(['diff', 'diff-tree']);
const GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);
const OPT_WITH_VALUE = new Set(['-n', '--max-count', '--skip', '--grep', '--author', '--committer', '--since', '--until', '--after', '--before',
  '-G', '-S', '--format', '--pretty', '-U', '--unified', '--diff-filter', '-L', '-O', '--output', '--encoding', '--min-parents', '--max-parents']);
const MOVING_NAMES = new Set(['HEAD', '@', 'FETCH_HEAD', 'ORIG_HEAD', 'MERGE_HEAD', 'main', 'master']);
const MOVING_PREFIXES = ['origin/', 'upstream/', 'refs/heads/', 'refs/remotes/'];
const SHA_RE = /^[0-9a-f]{7,40}$/i;
const SUFFIX_RE = /(?:[~^]\d*)+$/;

// Shell words grouped by command segment. Single quotes are opaque (a git word inside them is text, not a
// command); double quotes are transparent so "$(git …)" is still seen. Segments end at | ; & ( ) ` and newlines.
export function shellSegments(run) {
  const segments = [];
  let words = [];
  let word = '';
  let has = false;
  const endWord = () => { if (has) words.push(word); word = ''; has = false; };
  const endSegment = () => { endWord(); if (words.length) segments.push(words); words = []; };
  for (let i = 0; i < run.length; i++) {
    const ch = run[i];
    if (ch === "'") {
      const j = run.indexOf("'", i + 1);
      const end = j === -1 ? run.length : j;
      word += run.slice(i + 1, end);
      has = true;
      i = end;
    } else if (ch === '"') {
      has = true;
    } else if (ch === '\\' && i + 1 < run.length) {
      word += run[++i];
      has = true;
    } else if ('|;&()`\n'.includes(ch)) {
      endSegment();
    } else if (/\s/.test(ch)) {
      endWord();
    } else {
      word += ch;
      has = true;
    }
  }
  endSegment();
  return segments;
}

// True when the ref named by `token` moves: HEAD in any form, main/master, remote and branch namespaces, or a
// branch of the repository. SHAs and {order_commit} (with ^, ^N, ~N) are fixed. Unknown names (tags, shell
// variables) are not judged.
export function isMovingRef(token, branches = new Set()) {
  if (token.includes('@{')) return true;
  const base = token.replace(SUFFIX_RE, '');
  if (base === ORDER_COMMIT || SHA_RE.test(base)) return false;
  if (MOVING_NAMES.has(base)) return true;
  if (MOVING_PREFIXES.some((p) => base.startsWith(p))) return true;
  return branches.has(base);
}

// The revision arguments of one git invocation (after the subcommand, before "--"), without options,
// pathspecs and redirections.
function gitInvocation(words) {
  const g = words.indexOf('git');
  if (g === -1) return null;
  let i = g + 1;
  while (i < words.length && words[i].startsWith('-')) {
    if (GLOBAL_WITH_VALUE.has(words[i])) i++;
    i++;
  }
  const cmd = words[i];
  if (!cmd) return null;
  const revs = [];
  for (let k = i + 1; k < words.length; k++) {
    const w = words[k];
    if (w === '--') break;
    if (/^\d*[<>]/.test(w)) { if (/^\d*[<>]+$/.test(w)) k++; continue; }
    if (w.startsWith('-')) { if (OPT_WITH_VALUE.has(w)) k++; continue; }
    if (w.startsWith(':')) continue; // pathspec magic, for example ':!path'
    revs.push(w);
  }
  return { cmd, revs };
}

// The moving refs a check's run string uses as the end of a range: [{ token, command }].
export function scanMovingRefs(run, { branches = new Set() } = {}) {
  const found = [];
  for (const words of shellSegments(run)) {
    const inv = gitInvocation(words);
    if (!inv || !RANGE_CMDS.has(inv.cmd)) continue;
    const ends = [];
    const ranges = inv.revs.filter((r) => r.includes('..'));
    for (const r of ranges) {
      const right = r.slice(r.lastIndexOf('..') + 2);
      ends.push(right === '' ? 'HEAD' : right);
    }
    if (!ranges.length && TWO_POINT_CMDS.has(inv.cmd) && inv.revs.length >= 2) ends.push(inv.revs[inv.revs.length - 1]);
    for (const t of ends) if (isMovingRef(t, branches)) found.push({ token: t, command: `git ${inv.cmd}` });
  }
  return found;
}

// Local and remote-tracking branch names (short form), read once per validate. Empty outside a repository.
export function readBranches(dir) {
  const r = spawnSync('git', ['-C', dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'], { encoding: 'utf8' });
  if (r.status !== 0) return new Set();
  return new Set(r.stdout.split('\n').map((l) => l.trim()).filter(Boolean));
}

// Nearest directory from `start` upwards that contains .analucia/ (null if none).
export function projectRoot(start) {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, '.analucia'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

const versionParts = (v) => String(v).split('.').map((n) => Number.parseInt(n, 10) || 0);
export function versionAtLeast(v, min) {
  const a = versionParts(v);
  const b = versionParts(min);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

// 'error' for an order with no record.created yet or admitted with pins.plugin >= MOVING_REF_SINCE;
// 'warning' for an order admitted earlier (its verify file was written before the rule).
export function movingRefSeverity(events, orderId) {
  const created = events.find((e) => e?.type === 'record.created' && e.subject === orderId);
  if (!created) return 'error';
  const plugin = created.payload?.pins?.plugin;
  return plugin && versionAtLeast(plugin, MOVING_REF_SINCE) ? 'error' : 'warning';
}

// The newest commit whose message has the trailer line "Analucia-Order: <id>" (full SHA), or null.
export function resolveOrderCommit(root, id) {
  const pattern = `^Analucia-Order: ${id.replace(/[.]/g, '\\.')}$`;
  const r = spawnSync('git', ['-C', root, 'log', '-n', '1', '--format=%H', `--grep=${pattern}`], { encoding: 'utf8' });
  const sha = r.status === 0 ? r.stdout.trim() : '';
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

export const usesOrderCommit = (run) => run.includes(ORDER_COMMIT);
export const resolveRun = (run, sha) => run.split(ORDER_COMMIT).join(sha);
