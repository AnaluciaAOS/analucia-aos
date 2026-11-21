// ORD-0041 part 3: sessions named by their role, without the user doing it. Built the first way of the order: a
// plugin hook can set the title of a session (hook output `hookSpecificOutput.sessionTitle`, on SessionStart and on
// UserPromptSubmit; tried on Claude Code 2.1.277 in a scratch configuration). The name comes from the role the
// session declared and the project: DIRECTOR, or EJECUTOR <project code or folder name>. A name a person gave is
// never replaced. DT <topic> is a role outside the plugin: only its naming rule is written down.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { logPath, readLog } from '../lib/log.mjs';
import { isOwnName, sessionName, titleToSet } from '../lib/session-names.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const PLUGIN = fileURLToPath(new URL('..', import.meta.url));
const baseEnv = { ...process.env };
delete baseEnv.CLAUDE_PROJECT_DIR;
delete baseEnv.CLAUDE_CODE_SESSION_ID;
const hook = (cwd, input, env = baseEnv) => spawnSync(process.execPath, [AOS, 'hook', 'session-name'], { encoding: 'utf8', cwd, env, input: JSON.stringify({ cwd, ...input }) });
const aos = (root, args, env = baseEnv) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input: '', env });

function project({ code } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aos-names-'));
  mkdirSync(join(root, '.analucia'));
  writeFileSync(join(root, '.analucia', 'project.json'), `${JSON.stringify({ wip_limit: 1, locale: 'en', ...(code ? { project_code: code } : {}) })}\n`);
  writeFileSync(logPath(root), '');
  return root;
}
const title = (r) => (r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : null);

test('the name: EJECUTOR <project code or folder name>, DIRECTOR for a session that declared that role', () => {
  const coded = project({ code: 'SHOP' });
  assert.equal(sessionName(coded, 's1'), 'EJECUTOR SHOP');
  const plain = project();
  assert.equal(sessionName(plain, 's1'), `EJECUTOR ${basename(plain)}`);
  // The role is declared with the session id the agent's shell carries (CLAUDE_CODE_SESSION_ID).
  const r = aos(coded, ['role', 'declare', 'director', '--scope', '.analucia/drafts/**'], { ...baseEnv, CLAUDE_CODE_SESSION_ID: 's1' });
  assert.equal(r.status, 0, r.stderr);
  const declared = readLog(coded).events.at(-1);
  assert.deepEqual([declared.type, declared.actor, declared.agent.session], ['role.declared', 'director', 's1']);
  assert.equal(sessionName(coded, 's1'), 'DIRECTOR SHOP'); // ORD-0043 part 10: the name carries the project
  assert.equal(sessionName(coded, 's2'), 'EJECUTOR SHOP', 'another session keeps its own role');
  assert.equal(sessionName(coded, null), 'EJECUTOR SHOP');
  assert.ok(isOwnName(coded, 'DIRECTOR') && isOwnName(coded, 'EJECUTOR SHOP'));
  for (const byHand of ['My refactor', 'EJECUTOR', 'EJECUTOR LOOP SHOP', 'EJECUTOR OTHER', 'DT pricing']) assert.equal(isOwnName(coded, byHand), false, byHand);
});

test('a name a person gave is never replaced; our own name is replaced when the role changed', () => {
  const root = project({ code: 'SHOP' });
  assert.equal(titleToSet(root, 'EJECUTOR SHOP', undefined), 'EJECUTOR SHOP', 'no title yet');
  assert.equal(titleToSet(root, 'EJECUTOR SHOP', ''), 'EJECUTOR SHOP');
  assert.equal(titleToSet(root, 'EJECUTOR SHOP', 'EJECUTOR SHOP'), null, 'already right: nothing to say');
  assert.equal(titleToSet(root, 'DIRECTOR', 'EJECUTOR SHOP'), 'DIRECTOR', 'the role was declared later');
  assert.equal(titleToSet(root, 'EJECUTOR SHOP', 'DIRECTOR'), null, 'a session named DIRECTOR is not renamed back (a resumed session may carry another id)');
  assert.equal(titleToSet(root, 'EJECUTOR SHOP', 'Fix the invoices'), null, 'named by a person');
  assert.equal(titleToSet(root, 'EJECUTOR SHOP', 'EJECUTOR LOOP SHOP'), null, 'named by a person, even with the same first word');
  assert.equal(titleToSet(root, 'EJECUTOR SHOP', 'DT pricing'), null, 'an outside advisor names its own session');
});

test('the hook: at session start it sets the title; at a later prompt it renames after the role was declared', () => {
  const root = project({ code: 'SHOP' });
  const start = hook(root, { hook_event_name: 'SessionStart', session_id: 's1', source: 'startup' });
  assert.equal(start.status, 0, start.stderr);
  assert.deepEqual(title(start), { hookEventName: 'SessionStart', sessionTitle: 'EJECUTOR SHOP' });
  assert.equal(start.stdout.trim().split('\n').length, 1, 'one line of JSON, nothing else');
  // Next prompt, same title: silent.
  const same = hook(root, { hook_event_name: 'UserPromptSubmit', session_id: 's1', session_title: 'EJECUTOR SHOP', prompt: 'x' });
  assert.equal(same.stdout, '');
  assert.equal(same.status, 0);
  // The session declares director; at the next prompt it is renamed.
  assert.equal(aos(root, ['role', 'declare', 'director', '--scope', '.analucia/drafts/**'], { ...baseEnv, CLAUDE_CODE_SESSION_ID: 's1' }).status, 0);
  const later = hook(root, { hook_event_name: 'UserPromptSubmit', session_id: 's1', session_title: 'EJECUTOR SHOP', prompt: 'x' });
  assert.deepEqual(title(later), { hookEventName: 'UserPromptSubmit', sessionTitle: 'DIRECTOR SHOP' });
  // A session the owner named by hand keeps its name, at start (a resume) and at a prompt.
  for (const input of [{ hook_event_name: 'SessionStart', source: 'resume' }, { hook_event_name: 'UserPromptSubmit', prompt: 'x' }]) {
    assert.equal(hook(root, { ...input, session_id: 's9', session_title: 'Revisión de precios' }).stdout, '');
  }
  // The hook writes nothing: the log has the one declaration and no more.
  assert.equal(readLog(root).events.length, 1);
  // Outside a project it is silent and exits 0.
  const bare = mkdtempSync(join(tmpdir(), 'aos-names-bare-'));
  const out = hook(bare, { hook_event_name: 'SessionStart', session_id: 's1', source: 'startup' });
  assert.equal(out.status, 0);
  assert.equal(out.stdout, '');
});

test('the plugin registers the hook on SessionStart and UserPromptSubmit, next to the existing ones', () => {
  const hooks = JSON.parse(readFileSync(join(PLUGIN, 'hooks', 'hooks.json'), 'utf8')).hooks;
  const commands = (event) => hooks[event].flatMap((h) => h.hooks.map((x) => x.command));
  assert.ok(commands('SessionStart').some((c) => c.endsWith('hook session-start')), 'the resume hook stays');
  assert.ok(commands('SessionStart').some((c) => c.endsWith('hook session-name')));
  // ORD-0042 part 8: on a prompt the same naming runs inside the prompt hook, which also warns about a prompt of another project.
  assert.ok(commands('UserPromptSubmit').some((c) => c.endsWith('hook user-prompt')));
  for (const event of ['SessionEnd', 'Stop', 'PreCompact', 'PreToolUse']) assert.ok(hooks[event], event);
});

test('the first lines a session prints also say the name, and the naming rule of DT is written down', () => {
  const root = project({ code: 'SHOP' });
  const r = spawnSync(process.execPath, [AOS, 'hook', 'session-start'], { encoding: 'utf8', cwd: root, env: baseEnv, input: JSON.stringify({ cwd: root, session_id: 's1', source: 'startup' }) });
  const lines = r.stdout.split('\n');
  assert.match(lines[0], /^Status: /);
  assert.equal(lines[3], 'Session name: EJECUTOR SHOP (the plugin sets it; if this window shows another name, rename it to this one)');
  const entry = readFileSync(join(PLUGIN, 'templates', 'director-entry.md'), 'utf8');
  assert.match(entry, /role declare director/);
  assert.match(entry, /DIRECTOR/);
  assert.match(entry, /DT <topic>/);
  assert.match(readFileSync(join(PLUGIN, 'docs', 'INDEX.md'), 'utf8'), /DT <topic>/);
});
