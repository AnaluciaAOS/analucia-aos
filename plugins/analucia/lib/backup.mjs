// aos backup (ORD-0024 part A): a snapshot of the working tree, including uncommitted and untracked files that are
// not git-ignored, pushed to backup/<YYYY-MM-DD> on the remote. It never checks anything out: the snapshot is built
// in a temporary index (GIT_INDEX_FILE) and committed with "git commit-tree", so the current branch, the working tree,
// the real index and main stay as they were. Before pushing, every file of the snapshot passes the same secret patterns
// as the pre-push guard; a match pushes nothing and names the file and line, never the value.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, timestampFor } from './log.mjs';
import { isEnvLike, tokenPatterns } from './secret-patterns.mjs';
import { RuleError } from './state.mjs';

const run = (root, args, env) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env });
const must = (r, what) => {
  if (r.status !== 0) throw new RuleError('E_BACKUP', `${what} failed: ${(r.stderr || r.stdout || '').trim().split('\n').at(-1)}`);
  return r.stdout.trim();
};

export const backupBranch = (root, now = new Date()) => `backup/${timestampFor(root, now).slice(0, 10)}`;

// Files of the snapshot whose content matches a secret pattern, or that are .env-like files (which hold secrets by
// design and must never leave the machine). [{ file, line, pattern }], values never kept.
export function snapshotSecrets(root, files) {
  const patterns = tokenPatterns();
  const found = [];
  for (const file of files) {
    if (isEnvLike(file)) { found.push({ file, line: 0, pattern: 'env_file' }); continue; }
    let buf;
    try { buf = readFileSync(join(root, file)); } catch { continue; }
    if (buf.includes(0)) continue; // binary
    buf.toString('utf8').split(/\r?\n/).forEach((text, i) => {
      for (const p of patterns) if (p.re.test(text)) found.push({ file, line: i + 1, pattern: p.name });
    });
  }
  return found;
}

export function backup(root, { remote = 'origin', now = new Date(), actor = 'system' } = {}) {
  if (run(root, ['rev-parse', '--is-inside-work-tree']).stdout.trim() !== 'true') throw new RuleError('E_BACKUP', 'this folder is not a git work tree: there is nothing to back up');
  const head = run(root, ['rev-parse', '--verify', '-q', 'HEAD']).stdout.trim() || null;
  const dir = mkdtempSync(join(tmpdir(), 'aos-backup-'));
  const env = { GIT_INDEX_FILE: join(dir, 'index') };
  try {
    // The snapshot: HEAD's tree plus every change in the working tree, ignored files left out.
    if (head) must(run(root, ['read-tree', head], env), 'git read-tree');
    must(run(root, ['add', '-A', '--', '.'], env), 'git add (temporary index)');
    const files = must(run(root, ['ls-files', '-z'], env), 'git ls-files').split('\0').filter(Boolean);
    const secrets = snapshotSecrets(root, files);
    if (secrets.length) {
      throw Object.assign(new RuleError('E_SECRET', `backup refused: ${secrets.length} place(s) in the snapshot look like a secret (values not shown); nothing was pushed`),
        { problems: secrets.map((s) => (s.line ? `${s.file}:${s.line} matches ${s.pattern}` : `${s.file} is an environment file (it stays on this machine)`)) });
    }
    const tree = must(run(root, ['write-tree'], env), 'git write-tree');
    const branch = backupBranch(root, now);
    // A second backup on the same day goes on top of the first, so the push is a fast-forward (never forced).
    const remoteTip = must(run(root, ['ls-remote', remote, `refs/heads/${branch}`]), 'git ls-remote').split(/\s/)[0] || null;
    if (remoteTip) must(run(root, ['fetch', '-q', remote, `refs/heads/${branch}`]), 'git fetch');
    const parents = [head, remoteTip].filter(Boolean).flatMap((p) => ['-p', p]);
    const message = `Backup ${branch.slice(7)}: snapshot of the working tree (aos backup)`;
    const commit = must(run(root, ['commit-tree', tree, ...parents, '-m', message]), 'git commit-tree');
    must(run(root, ['push', '-q', remote, `${commit}:refs/heads/${branch}`]), 'git push');
    appendEvent(root, { type: 'backup.pushed', actor, subject: null, payload: { branch, commit, files: files.length, remote } }, { now });
    return { branch, commit, files: files.length, remote };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The latest backup branch on the remote and the commands that bring it back without touching the current work.
export function restoreHint(root, { remote = 'origin' } = {}) {
  const heads = run(root, ['ls-remote', '--heads', remote, 'backup/*']).stdout.split('\n').map((l) => l.split('\t')[1]).filter(Boolean)
    .map((r) => r.replace('refs/heads/', '')).sort();
  const branch = heads.at(-1) ?? null;
  if (!branch) return { branch: null, commands: [] };
  const day = branch.slice(7);
  return { branch, commands: [`git fetch ${remote} ${branch}`, `git worktree add ../restore-${day} FETCH_HEAD`] };
}
