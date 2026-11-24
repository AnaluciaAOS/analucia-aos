// ORD-0047 part 11 (OBS-192): no git command waits for ever. `aos install-git-hooks` writes, in the repository's own
// configuration, the settings that make git fail at once; the network calls of the plugin have a time limit and never
// prompt; the rules block says that a git command that does not end in two minutes is stopped and the run finishes blocked.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FAIL_FAST_CONFIG, GIT_TIMEOUT_MS, NO_PROMPT_ENV, applyFailFastConfig, gitNetwork, timeoutLine } from '../lib/git-timeout.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'aos-timeout-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 't');
  git(root, 'config', 'user.email', 't@example.com');
  return root;
}
const cfg = (root, key) => git(root, 'config', '--local', '--get', key).stdout.trim();

test('install-git-hooks writes the fail-fast settings in the repository\'s own configuration, once, and says so', () => {
  const root = repo();
  const run = () => spawnSync(process.execPath, [AOS, 'install-git-hooks', '--root', root], { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  for (const [key, value] of Object.entries(FAIL_FAST_CONFIG)) assert.equal(cfg(root, key), value, key);
  assert.equal(GIT_TIMEOUT_MS, 120000, 'two minutes');
  assert.equal(NO_PROMPT_ENV.GIT_TERMINAL_PROMPT, '0');
  // a second time nothing changes
  assert.deepEqual(applyFailFastConfig(root, { dryRun: true }), []);
  // a setting that differs is put right; a dry run changes nothing
  git(root, 'config', '--local', 'credential.interactive', 'true');
  assert.deepEqual(applyFailFastConfig(root, { dryRun: true }).map((c) => c.key), ['credential.interactive']);
  assert.equal(cfg(root, 'credential.interactive'), 'true');
  assert.equal(run().status, 0);
  assert.equal(cfg(root, 'credential.interactive'), 'false');
});

test('a network call that hangs is stopped at the limit, with no prompt, and says what did not end', () => {
  const root = repo();
  git(root, 'remote', 'add', 'origin', 'ssh://scratch.invalid/repo.git');
  // The transport is a command that never answers: what a push waiting for a hidden window looks like.
  const hang = { GIT_SSH_COMMAND: 'node -e "setTimeout(function(){},60000)"' };
  const t0 = Date.now();
  const r = gitNetwork(root, ['ls-remote', 'origin'], { timeout: 1500, env: hang });
  const took = Date.now() - t0;
  assert.equal(r.timedOut, true);
  assert.equal(r.status, 124);
  assert.ok(took < 15000, `stopped after ${took} ms`);
  assert.match(r.stderr, /git ls-remote origin did not end in 2 seconds and was stopped|did not end in 1\.5 seconds|did not end in 2 seconds/);
  assert.match(timeoutLine(r), /was stopped/);
  // a call that ends in time is not touched
  const ok = gitNetwork(root, ['rev-parse', '--git-dir']);
  assert.equal(ok.timedOut, false);
  assert.equal(ok.status, 0);
  assert.equal(timeoutLine(ok), null);
});

test('the plugin\'s own network calls go through the time limit; the rules block states the two minutes', () => {
  const src = (f) => readFileSync(fileURLToPath(new URL(`../lib/${f}`, import.meta.url)), 'utf8');
  assert.match(src('sign.mjs'), /ownerPush = \(root\) => gitNetwork\(/);
  assert.match(src('sign.mjs'), /gitNetwork\(root, \['fetch'/);
  assert.match(src('backup.mjs'), /NETWORK\.has\(args\[0\]\) \? gitNetwork/);
  assert.match(src('guards.mjs'), /timeout: GIT_TIMEOUT_MS/);
  const block = readFileSync(fileURLToPath(new URL('../core/AGENTS.block.md', import.meta.url)), 'utf8');
  assert.match(block, /a git command not ended in 2 minutes \(it is stopped\): finish `blocked`, naming it/);
});
