// ORD-0047 part 6 (OBS-208): the director answers from the state, not from memory. `aos status --director` prints the
// state from the log plus where local `main` and `origin/main` are, in a few lines. Local git only: it never fetches.
import { spawnSync } from 'node:child_process';
import { readLog } from './log.mjs';
import { TERMINAL, statusOf } from './status.mjs';

const git = (root, args) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000 });
  return r.status === 0 ? r.stdout.trim() : null;
};

// The lines about git: the current branch, main and origin/main with their short commits, and whether they differ.
export function gitPositionLines(root) {
  const short = (ref) => git(root, ['rev-parse', '--short', ref]);
  if (git(root, ['rev-parse', '--is-inside-work-tree']) !== 'true') return ['git: this folder is not a git repository (or git is not available): no position of main to report.'];
  const main = short('refs/heads/main');
  const origin = short('refs/remotes/origin/main');
  const lines = [`git: current branch ${git(root, ['symbolic-ref', '--short', 'HEAD']) ?? '(detached)'}`];
  if (!main) lines.push('git: there is no local main.');
  if (!origin) lines.push('git: there is no origin/main here (never fetched, or no remote).');
  if (main && origin) {
    if (main === origin) lines.push(`git: local main and origin/main are at the same commit (${main}).`);
    else {
      const counts = git(root, ['rev-list', '--left-right', '--count', 'refs/heads/main...refs/remotes/origin/main']);
      const [ahead, behind] = (counts ?? '0\t0').split(/\s+/).map(Number);
      lines.push(`git: local main (${main}) and origin/main (${origin}) DIFFER: main is ${ahead} commit(s) ahead and ${behind} behind. Fetch before you say which one is newer.`);
    }
  } else if (main) lines.push(`git: local main is at ${main}.`);
  return lines;
}

// The whole answer: the state of the orders from the log, then the git position.
export function directorStatusLines(root) {
  const lines = ['Director status (read from the log and git just now; answer from this, not from memory):'];
  let events;
  try {
    events = readLog(root).events;
  } catch (x) {
    lines.push(`log: cannot be read (${x.code ?? 'error'}: ${x.message}). Run "aos verify-log".`);
    return [...lines, ...gitPositionLines(root)];
  }
  const all = statusOf(root, events);
  const open = all.filter((s) => !TERMINAL.has(s.state));
  lines.push(`orders: ${all.length} in the log, ${open.length} not closed, ${all.length - open.length} closed or dropped; last event ${events.at(-1)?.ts ?? 'none'}.`);
  for (const s of open) lines.push(`  ${s.id} — ${s.state} — held by ${s.holder.who}${s.why ? ` — ${s.why}` : ''} — since ${s.since}`);
  return [...lines, ...gitPositionLines(root)];
}
