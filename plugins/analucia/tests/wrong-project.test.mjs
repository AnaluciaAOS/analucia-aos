// ORD-0042 part 8 (OBS-152): a prompt of another project is refused. The prompt hook (UserPromptSubmit) reads the
// prompt and adds one line of context for the session, never blocking the prompt itself, in three cases: the prompt
// names a record ID that carries the code of another project registered on this computer; it names a record ID
// that does not exist in this project; it starts with a line `Project: <name>` and the name is neither the code nor
// the folder name of this project. A prompt of this project gets no line. Nothing is read outside the project
// folder except the list of codes the tool already keeps (here: a scratch CLAUDE_CONFIG_DIR).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { blockTemplate } from '../lib/guards.mjs';
import { appendEvent, logPath, readLog } from '../lib/log.mjs';
import { wrongProjectNote } from '../lib/wrong-project.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const PLUGIN = fileURLToPath(new URL('..', import.meta.url));
const CONFIG = mkdtempSync(join(tmpdir(), 'aos-wrong-cfg-'));
const env = { ...process.env, CLAUDE_CONFIG_DIR: CONFIG };
delete env.CLAUDE_PROJECT_DIR;
delete env.CLAUDE_CODE_SESSION_ID;
const hook = (root, prompt, extra = {}) => spawnSync(process.execPath, [AOS, 'hook', 'user-prompt'], { encoding: 'utf8', cwd: root, env, input: JSON.stringify({ cwd: root, hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt, ...extra }) });
const context = (r) => (r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext ?? null : null);

function project(code, orders = []) {
  const root = mkdtempSync(join(tmpdir(), `aos-wrong-${code.toLowerCase()}-`));
  mkdirSync(join(root, '.analucia', 'orders'), { recursive: true });
  mkdirSync(join(root, '.analucia', 'drafts'), { recursive: true });
  writeFileSync(join(root, '.analucia', 'project.json'), `${JSON.stringify({ wip_limit: 1, locale: 'en', project_code: code })}\n`);
  writeFileSync(logPath(root), '');
  for (const id of orders) {
    writeFileSync(join(root, '.analucia', 'orders', `${id}.md`), 'x\n');
    appendEvent(root, { type: 'record.created', actor: 'director', subject: id });
  }
  return root;
}
const here = project('SHOP', ['SHOP-0001', 'SHOP-0002']);
// This project also has records from before it had a code.
writeFileSync(join(here, '.analucia', 'orders', 'ORD-0004.md'), 'x\n');
const other = project('BOOK', ['BOOK-0001']);
mkdirSync(join(CONFIG, 'analucia'), { recursive: true });
writeFileSync(join(CONFIG, 'analucia', 'project-codes.json'), JSON.stringify({ codes: { SHOP: here.split('\\').join('/'), BOOK: other.split('\\').join('/') } }));
const cfg = { configDir: CONFIG };

test('case 1: the prompt names a record that carries the code of another project of this computer', () => {
  const r = hook(here, 'Run BOOK-0001 exactly as written.');
  assert.equal(r.status, 0, 'the prompt itself is never blocked');
  const line = context(r);
  assert.match(line, /^Analucia: this prompt is for another project/);
  assert.match(line, /BOOK-0001 carries the code BOOK, which belongs to the project in /);
  assert.ok(line.includes(other.split('\\').join('/')), 'it says which folder has that code');
  assert.match(line, /Do nothing with it and tell the owner\.$/);
  assert.equal(line.split('\n').length, 1, 'one line');
  assert.equal(wrongProjectNote(here, 'Continue BOOK-AMD-0002 please', cfg).case, 1);
});

test('case 2: the prompt names a record that does not exist in this project', () => {
  const line = context(hook(here, 'Run ORD-0041 exactly as written: read .analucia/orders/ORD-0041.md first.'));
  assert.match(line, /^Analucia: this prompt is for another project/);
  assert.match(line, /ORD-0041 does not exist in this project/);
  assert.equal(wrongProjectNote(here, 'Run SHOP-0009', cfg).case, 2);
  assert.equal(wrongProjectNote(here, 'Answer ASK-0003 and AMD-0010', cfg).case, 2);
  // A draft counts as existing, and so do amendment and ask files.
  writeFileSync(join(here, '.analucia', 'drafts', 'SHOP-0003.md'), 'x\n');
  assert.equal(wrongProjectNote(here, 'Check the draft SHOP-0003', cfg), null);
});

test('case 3: the prompt starts with Project: <name> and the name is neither the code nor the folder of this project', () => {
  const line = context(hook(here, 'Project: BOOK\nRun the next order.'));
  assert.match(line, /^Analucia: this prompt is for another project/);
  assert.match(line, /its first line says "Project: BOOK"; this project is SHOP \(folder /);
  assert.equal(wrongProjectNote(here, 'Project: some-other-folder\n\nContinue.', cfg).case, 3);
  assert.equal(wrongProjectNote(here, 'Project: SHOP\nRun SHOP-0001.', cfg), null, 'the code of this project');
  assert.equal(wrongProjectNote(here, `Project: ${basename(here)}\nRun SHOP-0001.`, cfg), null, 'the folder name of this project');
  assert.equal(wrongProjectNote(here, 'Project:   shop  \ncontinue', cfg), null, 'case and spaces do not matter');
});

test('a prompt of this project gets no line, and words that only look like IDs are not judged', () => {
  for (const prompt of [
    'Run SHOP-0001 exactly as written.',
    'Continue with ORD-0004 and then SHOP-0002.',
    'continue',
    'What does ISO-8601 or RFC-2119 say about dates? And UTF-0008?',
    'Read SPEC-0002 and OBS-0155, and DEC-0001.',
    'The project: BOOK is not this one, I know.',
    '',
  ]) {
    const r = hook(here, prompt);
    assert.equal(r.status, 0);
    assert.equal(context(r), null, prompt);
  }
  // The hook still names the session (ORD-0041 part 3), with or without a note.
  const titled = JSON.parse(hook(here, 'continue', { session_title: '' }).stdout).hookSpecificOutput;
  assert.deepEqual(titled, { hookEventName: 'UserPromptSubmit', sessionTitle: 'EJECUTOR SHOP' });
  const both = JSON.parse(hook(here, 'Run BOOK-0001', { session_title: '' }).stdout).hookSpecificOutput;
  assert.equal(both.sessionTitle, 'EJECUTOR SHOP');
  assert.match(both.additionalContext, /another project/);
  // It writes nothing, and outside a project it is silent.
  assert.equal(readLog(here).events.length, 2);
  const bare = mkdtempSync(join(tmpdir(), 'aos-wrong-bare-'));
  assert.equal(hook(bare, 'Run BOOK-0001').stdout, '');
});

test('the plugin runs it on every prompt; the rules block and the director entrypoint say the rule', () => {
  const hooks = JSON.parse(readFileSync(join(PLUGIN, 'hooks', 'hooks.json'), 'utf8')).hooks;
  assert.ok(hooks.UserPromptSubmit.flatMap((h) => h.hooks.map((x) => x.command)).some((c) => c.endsWith('hook user-prompt')));
  const line = blockTemplate().split('\n').find((l) => /not this one/.test(l));
  assert.ok(line, 'one line in the rules block');
  assert.match(line, /\.analucia\/orders\//);
  assert.match(line, /stop and say so/);
  const entry = readFileSync(join(PLUGIN, 'templates', 'director-entry.md'), 'utf8');
  assert.match(entry, /its first line is `Project: <code or folder name>`/);
});
