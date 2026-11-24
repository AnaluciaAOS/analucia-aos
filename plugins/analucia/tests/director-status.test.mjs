// ORD-0047 part 6 (OBS-208): `aos status --director` answers from the log and from git; a session declared director
// gets it at SessionStart; an executor session does not.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gitPositionLines } from '../lib/director-status.mjs';
import { logPath } from '../lib/log.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const TPL = (n) => readFileSync(fileURLToPath(new URL(`../templates/${n}`, import.meta.url)), 'utf8');
const baseEnv = { ...process.env };
delete baseEnv.CLAUDE_PROJECT_DIR;
delete baseEnv.CLAUDE_CODE_SESSION_ID;
const aos = (root, args, env = baseEnv) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', env });
const sh = (cwd, cmd, args) => spawnSync(cmd, args, { cwd, encoding: 'utf8' });
const git = (cwd, ...a) => sh(cwd, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a]);

function project() {
  const root = mkdtempSync(join(tmpdir(), 'aos-dirstatus-'));
  mkdirSync(join(root, '.analucia', 'drafts'), { recursive: true });
  writeFileSync(join(root, '.analucia', 'project.json'), `${JSON.stringify({ wip_limit: 1, locale: 'en', project_code: 'SHOP' })}\n`);
  writeFileSync(logPath(root), '');
  git(root, 'init', '-q', '-b', 'main');
  return root;
}
const start = (root, session) => spawnSync(process.execPath, [AOS, 'hook', 'session-start'], { encoding: 'utf8', cwd: root, env: baseEnv, input: JSON.stringify({ cwd: root, session_id: session, source: 'resume' }) });

test('the git position says whether main and origin/main are the same or differ', () => {
  const origin = mkdtempSync(join(tmpdir(), 'aos-dirstatus-o-'));
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  const dir = mkdtempSync(join(tmpdir(), 'aos-dirstatus-w-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'one');
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-q', 'origin', 'main');
  git(dir, 'fetch', '-q', 'origin');
  assert.match(gitPositionLines(dir).join('\n'), /same commit/);
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'two');
  const differ = gitPositionLines(dir).join('\n');
  assert.match(differ, /DIFFER/);
  assert.match(differ, /1 commit\(s\) ahead and 0 behind/);
  assert.match(gitPositionLines(mkdtempSync(join(tmpdir(), 'aos-dirstatus-n-'))).join('\n'), /not a git repository/);
});

test('aos status --director prints the state from the log and the git lines, and exits 0', () => {
  const root = project();
  const r = aos(root, ['status', '--director']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Director status/);
  assert.match(r.stdout, /orders: 0 in the log, 0 not closed/);
  assert.match(r.stdout, /git: current branch main/);
  assert.match(r.stdout, /there is no origin\/main/);
});

test('SessionStart prints it for a session declared director, and not for another one', () => {
  const root = project();
  assert.equal(aos(root, ['role', 'declare', 'director', '--scope', '.analucia/drafts/**'], { ...baseEnv, CLAUDE_CODE_SESSION_ID: 'd1' }).status, 0);
  assert.match(start(root, 'd1').stdout, /Director status \(read from the log and git just now/);
  assert.doesNotMatch(start(root, 'e1').stdout, /Director status/);
});

test('the director and the advisor entrypoints say to run it before answering', () => {
  for (const f of ['director-entry.md', 'advisor-entry.md']) assert.match(TPL(f), /aos\.mjs status --director/);
});
