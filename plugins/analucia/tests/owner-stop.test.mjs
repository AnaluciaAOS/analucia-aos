// ORD-0043 part 15 (OBS-172) and AMD-0019 section 2: the STOP of the owner wins. A prompt that is only STOP, ALTO,
// DETENER or PARA (any case, punctuation around it allowed) halts the project through the same function as `aos halt`;
// a longer prompt that starts with one of those words is an ordinary prompt (no halt, no record, no context). AVANZA
// alone is recorded and the session is told to run `aos next`. The record carries the word, the session and the time,
// never the prompt. The first line of every session and `aos status` name the DETENER launcher and the stop word.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { blockTemplate, halt, preToolUse, writeHalt } from '../lib/guards.mjs';
import { logPath, readLog } from '../lib/log.mjs';
import { ownerWord } from '../lib/owner-words.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env };
delete env.CLAUDE_PROJECT_DIR;
delete env.CLAUDE_CODE_SESSION_ID;
const aos = (root, args) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input: '', env });
const prompt = (root, text, session = 's1') => spawnSync(process.execPath, [AOS, 'hook', 'user-prompt'], { encoding: 'utf8', cwd: root, env, input: JSON.stringify({ cwd: root, hook_event_name: 'UserPromptSubmit', session_id: session, prompt: text }) });
const context = (r) => (r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext ?? '' : '');
const HALT = (root) => join(root, '.analucia', 'HALT');
const words = (root) => readLog(root).events.filter((e) => e.type === 'operation.logged' && e.payload?.operation === 'owner.word');

function project() {
  const root = mkdtempSync(join(tmpdir(), 'aos-ownerstop-'));
  mkdirSync(join(root, '.analucia'), { recursive: true });
  writeFileSync(join(root, '.analucia', 'project.json'), '{"wip_limit":1,"locale":"en","project_code":"SHOP"}\n');
  writeFileSync(logPath(root), '');
  return root;
}

test('the words: the whole prompt in any case, with or without punctuation; a longer prompt that starts with one is nothing', () => {
  for (const p of ['STOP', 'stop', 'Alto', '  DETENER \n', 'pArA', 'para.', '¡Alto!', 'DETENER!!', ' ¡¡stop!! ', '¿PARA?']) assert.equal(ownerWord(p)?.exact, true, p);
  assert.deepEqual(ownerWord('stop'), { word: 'STOP', exact: true, kind: 'stop' });
  assert.deepEqual(ownerWord('¡Alto!'), { word: 'ALTO', exact: true, kind: 'stop' });
  assert.deepEqual(ownerWord('avanza.'), { word: 'AVANZA', exact: true, kind: 'go' });
  assert.deepEqual(ownerWord('avanza'), { word: 'AVANZA', exact: true, kind: 'go' });
  for (const p of ['para qué sirve esto', 'alto el fuego en la prueba', 'para ahora mismo, por favor', 'Stop. Do not touch the prices', 'AVANZA con la cola', 'stopping the build', 'paramount', 'altos', 'do not stop', '', '   ', '!!!', 'what is a stop word?', 'stop stop']) assert.equal(ownerWord(p), null, JSON.stringify(p));
  assert.equal(ownerWord(null), null);
});

test('the exact word halts the project through the same function as aos halt, from any session', () => {
  for (const word of ['STOP', 'alto', 'DETENER', 'Para']) {
    const root = project();
    const r = prompt(root, word, 's1');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(HALT(root)), word);
    const h = JSON.parse(readFileSync(HALT(root), 'utf8'));
    assert.equal(h.by, 'owner');
    assert.equal(h.reason, `the owner said ${word.toUpperCase()} in the session EJECUTOR SHOP`);
    // The same record aos halt writes, and the one line for the session.
    const halted = readLog(root).events.filter((e) => e.type === 'operation.logged' && e.payload?.operation === 'halt');
    assert.equal(halted.length, 1);
    assert.equal(halted[0].actor, 'owner');
    assert.match(context(r), /halted/i);
    assert.match(context(r), /end what you are doing, start nothing new/i);
    assert.match(context(r), /REANUDAR/);
    // From now on every session of the project only reads.
    assert.match(preToolUse(root, { tool_name: 'Write', tool_input: { file_path: 'a.txt' } }) ?? '', /the owner said/);
    assert.equal(preToolUse(root, { tool_name: 'Read', tool_input: { file_path: 'a.txt' } }), null);
  }
  // A project that is already halted stays so: nothing is written twice and nothing fails.
  const root = project();
  prompt(root, 'STOP', 's1');
  const before = readFileSync(HALT(root), 'utf8');
  const again = prompt(root, 'ALTO', 's2');
  assert.equal(again.status, 0, again.stderr);
  assert.equal(readFileSync(HALT(root), 'utf8'), before);
  assert.equal(readLog(root).events.filter((e) => e.payload?.operation === 'halt').length, 1);
  assert.equal(words(root).length, 2, 'both words are recorded');
  // writeHalt is the one function: aos halt calls it after the owner terminal check.
  assert.throws(() => halt(project(), { reason: 'x', isTTY: false }), (x) => x.code === 'E_OWNER_TTY');
  const direct = project();
  assert.equal(writeHalt(direct, { reason: 'the owner said STOP in the session x' }), true);
  assert.equal(writeHalt(direct, { reason: 'again' }), false);
});

test('a longer prompt that starts with a stop word does nothing: no halt, no record, no line of context', () => {
  const root = project();
  for (const text of ['para qué sirve esto, the-secret-sentence-of-the-owner', 'alto el fuego en la prueba', 'stop everything, the-secret-sentence-of-the-owner', 'AVANZA con la cola']) {
    const r = prompt(root, text, 's9');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.includes('additionalContext'), false, text);
  }
  assert.equal(existsSync(HALT(root)), false);
  assert.equal(words(root).length, 0, 'nothing is recorded');
  assert.equal(readFileSync(logPath(root), 'utf8').includes('the-secret-sentence-of-the-owner'), false);
  // The word alone, with punctuation, is a stop: recorded with the word, the session and the time, never the prompt.
  const stop = prompt(root, '¡Alto!', 's9');
  assert.equal(stop.status, 0, stop.stderr);
  assert.ok(existsSync(HALT(root)));
  const recorded = words(root);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].actor, 'owner');
  assert.deepEqual({ ...recorded[0].payload, ts: undefined }, { operation: 'owner.word', word: 'ALTO', session: 's9', halted: true, ts: undefined });
  assert.ok(recorded[0].ts, 'the time is the time of the event');
  assert.equal(JSON.parse(readFileSync(HALT(root), 'utf8')).reason, 'the owner said ALTO in the session EJECUTOR SHOP');
});

test('the punctuated forms halt the project', () => {
  for (const text of ['para.', '¡Alto!', 'DETENER!!', 'Stop!']) {
    const root = project();
    const r = prompt(root, text, 's1');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(HALT(root)), text);
    assert.match(context(r), /halted/i);
  }
});

test('AVANZA is recorded and the session is told to run aos next with no question unless there is a material technical risk', () => {
  const root = project();
  const r = prompt(root, '¡AVANZA!', 's2');
  assert.equal(r.status, 0, r.stderr);
  assert.match(context(r), /run .*aos\.mjs" next and do what it says/);
  assert.match(context(r), /no question unless there is a material technical risk/);
  const [w] = words(root);
  assert.deepEqual({ word: w.payload.word, session: w.payload.session, halted: w.payload.halted }, { word: 'AVANZA', session: 's2', halted: false });
  assert.equal(readFileSync(logPath(root), 'utf8').includes('AVANZA con'), false);
  assert.equal(existsSync(HALT(root)), false);
  // In a halted project it does not undo the halt: only the owner resumes.
  prompt(root, 'STOP', 's2');
  const halted = prompt(root, 'avanza', 's2');
  assert.match(context(halted), /halted.*REANUDAR/i);
  assert.equal(existsSync(HALT(root)), true);
});

test('a halted project is resumed only at a terminal: an agent cannot, a hook cannot', () => {
  const root = project();
  prompt(root, 'DETENER', 's1');
  assert.ok(existsSync(HALT(root)));
  const r = aos(root, ['resume']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /E_OWNER_TTY/);
  assert.ok(existsSync(HALT(root)));
  // No prompt resumes it, whatever it says.
  for (const text of ['REANUDAR', 'resume', 'AVANZA', 'continue']) prompt(root, text, 's1');
  assert.ok(existsSync(HALT(root)));
});

test('the first line of every session and aos status name the DETENER launcher and the stop word', () => {
  const root = project();
  const start = spawnSync(process.execPath, [AOS, 'hook', 'session-start'], { encoding: 'utf8', cwd: root, env, input: JSON.stringify({ cwd: root, session_id: 's1', source: 'startup' }) });
  const line = start.stdout.split('\n').find((l) => /DETENER/.test(l));
  assert.ok(line, start.stdout);
  assert.match(line, /STOP/);
  assert.ok(start.stdout.split('\n').indexOf(line) <= 6, 'near the top of the session');
  const status = aos(root, ['status']);
  assert.match(status.stdout, /DETENER/);
  assert.match(status.stdout, /STOP/);
});

test('the rules block, the director entrypoint and the advisor entrypoint say it', () => {
  const block = blockTemplate();
  assert.match(block, /STOP, ALTO, DETENER or PARA/);
  assert.match(block, /start nothing new/);
  const tpl = (f) => readFileSync(fileURLToPath(new URL(`../templates/${f}`, import.meta.url)), 'utf8');
  for (const f of ['director-entry.md', 'advisor-entry.md']) {
    const text = tpl(f);
    assert.match(text, /The STOP of the owner wins/, f);
    assert.match(text, /`STOP`, `ALTO`, `DETENER` or `PARA`/, f);
    assert.match(text, /says in one line what is left open/, f);
    assert.match(text, /does not go on with its own plan/, f);
  }
});
