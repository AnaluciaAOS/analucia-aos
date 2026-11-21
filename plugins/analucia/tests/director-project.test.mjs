// ORD-0043 part 10 (OBS-151): one director per project. A session that declares director is named
// `DIRECTOR <project code or folder name>`; the PreToolUse hook refuses, for every role, a write or a delete inside
// the `.analucia/` folder of another project (E_OTHER_PROJECT); reading stays free.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { otherProjectPaths, preToolUse } from '../lib/guards.mjs';
import { logPath } from '../lib/log.mjs';
import { directorName, isOwnName, sessionName, titleToSet } from '../lib/session-names.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const PLUGIN = fileURLToPath(new URL('..', import.meta.url));
const baseEnv = { ...process.env };
delete baseEnv.CLAUDE_PROJECT_DIR;
delete baseEnv.CLAUDE_CODE_SESSION_ID;
const aos = (root, args, env = baseEnv, input = '') => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input, env });

function project({ code } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aos-dirproj-'));
  mkdirSync(join(root, '.analucia', 'drafts'), { recursive: true });
  writeFileSync(join(root, '.analucia', 'project.json'), `${JSON.stringify({ wip_limit: 1, locale: 'en', ...(code ? { project_code: code } : {}) })}\n`);
  writeFileSync(logPath(root), '');
  return root;
}
const declare = (root, session) => assert.equal(aos(root, ['role', 'declare', 'director', '--scope', '.analucia/drafts/**'], { ...baseEnv, CLAUDE_CODE_SESSION_ID: session }).status, 0);
const fwd = (p) => p.split('\\').join('/');

test('the name carries the project: DIRECTOR <project code or folder name>', () => {
  const coded = project({ code: 'SHOP' });
  declare(coded, 's1');
  assert.equal(directorName(coded), 'DIRECTOR SHOP');
  assert.equal(sessionName(coded, 's1'), 'DIRECTOR SHOP');
  assert.equal(sessionName(coded, 's2'), 'EJECUTOR SHOP');
  const plain = project();
  declare(plain, 's1');
  assert.equal(sessionName(plain, 's1'), `DIRECTOR ${basename(plain)}`);
  // Our own names: the two of this project, and the bare DIRECTOR of before, which is replaced by the new one.
  assert.ok(isOwnName(coded, 'DIRECTOR SHOP') && isOwnName(coded, 'DIRECTOR') && isOwnName(coded, 'EJECUTOR SHOP'));
  assert.equal(isOwnName(coded, 'DIRECTOR OTHER'), false, 'the director of another project is not ours to rename');
  assert.equal(titleToSet(coded, 'DIRECTOR SHOP', 'DIRECTOR'), 'DIRECTOR SHOP');
  assert.equal(titleToSet(coded, 'DIRECTOR SHOP', 'EJECUTOR SHOP'), 'DIRECTOR SHOP');
  assert.equal(titleToSet(coded, 'DIRECTOR SHOP', 'DIRECTOR SHOP'), null);
  // A session named as the director is not renamed back to an executor (a resumed session may carry another id).
  assert.equal(titleToSet(coded, 'EJECUTOR SHOP', 'DIRECTOR SHOP'), null);
  assert.equal(titleToSet(coded, 'EJECUTOR SHOP', 'DIRECTOR'), null);
  assert.equal(titleToSet(coded, 'DIRECTOR SHOP', 'DIRECTOR OTHER'), null, 'named by a person or by another project');
});

test('the hook sets that title, and the first lines of the session say that name', () => {
  const root = project({ code: 'SHOP' });
  declare(root, 's1');
  const hook = spawnSync(process.execPath, [AOS, 'hook', 'session-name'], { encoding: 'utf8', cwd: root, env: baseEnv, input: JSON.stringify({ cwd: root, hook_event_name: 'UserPromptSubmit', session_id: 's1', session_title: 'EJECUTOR SHOP', prompt: 'x' }) });
  assert.deepEqual(JSON.parse(hook.stdout).hookSpecificOutput, { hookEventName: 'UserPromptSubmit', sessionTitle: 'DIRECTOR SHOP' });
  const start = spawnSync(process.execPath, [AOS, 'hook', 'session-start'], { encoding: 'utf8', cwd: root, env: baseEnv, input: JSON.stringify({ cwd: root, session_id: 's1', source: 'resume' }) });
  assert.ok(start.stdout.split('\n').some((l) => l.startsWith('Session name: DIRECTOR SHOP ')), start.stdout);
});

test('a write or a delete inside the .analucia/ of another project is refused for every role; reading stays free', () => {
  const mine = project({ code: 'MINE' });
  const other = project({ code: 'OTHER' });
  const theirs = join(other, '.analucia', 'drafts', 'ORD-0001.md');
  for (const tool of ['Write', 'Edit', 'MultiEdit']) {
    const m = preToolUse(mine, { tool_name: tool, tool_input: { file_path: theirs } });
    assert.match(m, /E_OTHER_PROJECT/, tool);
    assert.match(m, /open a session in that project/);
  }
  // Any file there, not only the director files: the log, the project file, the evidence.
  for (const rel of ['events.jsonl', 'project.json', 'evidence/ORD-0001/report.md']) {
    assert.match(preToolUse(mine, { tool_name: 'Write', tool_input: { file_path: join(other, '.analucia', rel) } }), /E_OTHER_PROJECT/, rel);
  }
  // Shell: a redirection into it, and the write operators.
  for (const command of [
    `echo x > "${fwd(theirs)}"`,
    `rm -f ${fwd(theirs)}`,
    `cp notes.md ${fwd(join(other, '.analucia', 'drafts'))}/ORD-0002.md`,
    `Remove-Item "${theirs}"`,
    `mv ../${basename(other)}/.analucia/drafts/a.md /tmp/a.md`,
  ]) {
    for (const tool of ['Bash', 'PowerShell']) assert.match(preToolUse(mine, { tool_name: tool, tool_input: { command } }) ?? '', /E_OTHER_PROJECT/, command);
  }
  // Reading stays free, with the read tools and from the shell.
  for (const tool of ['Read', 'Grep', 'Glob']) assert.equal(preToolUse(mine, { tool_name: tool, tool_input: { file_path: theirs, path: theirs } }), null, tool);
  assert.equal(preToolUse(mine, { tool_name: 'Bash', tool_input: { command: `cat ${fwd(theirs)}` } }), null);
  assert.equal(preToolUse(mine, { tool_name: 'Bash', tool_input: { command: `cat ${fwd(theirs)} > /tmp/copy.md` } }), null, 'the target of the redirection is not theirs');
  assert.equal(preToolUse(mine, { tool_name: 'Bash', tool_input: { command: `grep -r price ${fwd(join(other, '.analucia'))} 2>/dev/null` } }), null);
  // This project is not "another project": its own unprotected files are written as before, and a folder inside it too.
  assert.equal(preToolUse(mine, { tool_name: 'Write', tool_input: { file_path: join(mine, '.analucia', 'drafts', 'ORD-0001.md') } }), null);
  assert.equal(preToolUse(mine, { tool_name: 'Write', tool_input: { file_path: join(mine, 'sub', '.analucia', 'x.md') } }), null);
  assert.equal(preToolUse(mine, { tool_name: 'Bash', tool_input: { command: 'rm -f .analucia/drafts/ORD-0001.md' } }), null);
  // A file of another project outside its .analucia/ is not this rule's.
  assert.equal(preToolUse(mine, { tool_name: 'Write', tool_input: { file_path: join(other, 'src', 'a.js') } }), null);
  // Its own protected paths keep their own message.
  assert.match(preToolUse(mine, { tool_name: 'Write', tool_input: { file_path: join(mine, '.analucia', 'orders', 'ORD-0001.md') } }), /protected path/);
  assert.deepEqual(otherProjectPaths(mine, { tool_name: 'Read', tool_input: { file_path: theirs } }), []);
});

test('the hook command blocks it with exit 2, for a session that declared director and for one that did not', () => {
  const mine = project({ code: 'MINE' });
  const other = project({ code: 'OTHER' });
  declare(mine, 's1');
  for (const session of ['s1', 's2']) {
    const r = spawnSync(process.execPath, [AOS, 'hook', 'pre-tool-use'], { encoding: 'utf8', cwd: mine, env: baseEnv, input: JSON.stringify({ cwd: mine, session_id: session, tool_name: 'Write', tool_input: { file_path: join(other, '.analucia', 'drafts', 'ORD-0001.md') } }) });
    assert.equal(r.status, 2, session);
    assert.match(r.stderr, /E_OTHER_PROJECT/);
  }
  const ok = spawnSync(process.execPath, [AOS, 'hook', 'pre-tool-use'], { encoding: 'utf8', cwd: mine, env: baseEnv, input: JSON.stringify({ cwd: mine, session_id: 's1', tool_name: 'Read', tool_input: { file_path: join(other, '.analucia', 'drafts', 'ORD-0001.md') } }) });
  assert.equal(ok.status, 0);
});

test('the director entrypoint says it: the name with the project, and one director per project', () => {
  const entry = readFileSync(join(PLUGIN, 'templates', 'director-entry.md'), 'utf8');
  assert.match(entry, /`DIRECTOR <project code or folder name>`/);
  const line = entry.split('\n').find((l) => /One director per project/i.test(l));
  assert.ok(line, 'one sentence');
  assert.match(line, /order of another project is written by the director of that project/);
  const explain = aos(project(), ['explain', 'E_OTHER_PROJECT']);
  assert.equal(explain.status, 0);
  assert.match(readFileSync(join(PLUGIN, 'docs', 'INDEX.md'), 'utf8'), /\(errors\/E_OTHER_PROJECT\.md\)/);
});
