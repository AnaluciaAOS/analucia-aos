// ORD-0047 part 11 (OBS-192): no git command waits for ever. A push stood "pushing" for eight hours: git waited for a
// typed password or an account window that nobody could see. Two things hold it:
//   1. `aos install-git-hooks` writes, in the repository's own configuration, the settings that make git fail at once
//      instead of waiting for a password or an account window (FAIL_FAST_CONFIG), and
//   2. every network call the plugin makes itself (the step to main of FIRMAR, the backup) runs through `gitNetwork`:
//      a time limit, no prompt, and a result that says it timed out.
// The rule of the executor (two minutes, then `blocked`) is in the rules block.
import { spawnSync } from 'node:child_process';

export const GIT_TIMEOUT_MS = 120000; // two minutes: the limit of the rules block
// Environment that makes git (and the credential helper that ships with it) fail instead of asking.
export const NO_PROMPT_ENV = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '' };
// The repository's own settings: fail at once, never open an account window, and drop a transfer that stalls.
export const FAIL_FAST_CONFIG = {
  'credential.interactive': 'false',
  'credential.guiPrompt': 'false',
  'http.lowSpeedLimit': '1000',
  'http.lowSpeedTime': '60',
};

const git = (root, args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });

// What differs in the repository's own configuration: [{ key, value, was }]. With dryRun nothing is written.
export function applyFailFastConfig(root, { dryRun = false } = {}) {
  const changed = [];
  for (const [key, value] of Object.entries(FAIL_FAST_CONFIG)) {
    const was = git(root, ['config', '--local', '--get', key]).stdout.trim();
    if (was === value) continue;
    if (!dryRun) git(root, ['config', '--local', key, value]);
    changed.push({ key, value, was: was || null });
  }
  return changed;
}

// A git call that goes to the network, with a time limit and no prompt. Returns the spawnSync result plus
// `timedOut` (true when the limit stopped it) and `what` (the command, for the line that names it).
export function gitNetwork(root, args, { timeout = GIT_TIMEOUT_MS, env = {} } = {}) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout, killSignal: 'SIGKILL', env: { ...process.env, ...NO_PROMPT_ENV, ...env } });
  const timedOut = r.error?.code === 'ETIMEDOUT';
  const out = Object.assign(r, { timedOut, limit: timeout, what: `git ${args.join(' ')}`, status: timedOut ? 124 : r.status });
  if (timedOut) out.stderr = `${timeoutLine(out)}
${out.stderr ?? ''}`;
  return out;
}

// One sentence for a call that timed out, or null.
export const timeoutLine = (r) => (r.timedOut ? `${r.what} did not end in ${Math.round((r.limit ?? GIT_TIMEOUT_MS) / 1000)} seconds and was stopped` : null);
