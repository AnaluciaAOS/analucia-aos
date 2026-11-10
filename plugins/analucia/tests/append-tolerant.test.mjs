// ORD-0019: an append validates only the event it appends and the hash chain, so a copy of the plugin that does
// not know a newer event type can still record its own events; full validation still reports the unknown type.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { appendEvent, logPath, readLog } from '../lib/log.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env };
delete env.CLAUDE_PROJECT_DIR;
const aos = (root, args, input = '') => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input, env });
const sha = (s) => createHash('sha256').update(s).digest('hex');

// A log whose second line was written by a newer plugin: a type this code does not know, correctly chained.
function logWithUnknownType() {
  const root = mkdtempSync(join(tmpdir(), 'aos-tolerant-'));
  mkdirSync(join(root, '.analucia'), { recursive: true });
  writeFileSync(join(root, '.analucia', 'project.json'), '{"wip_limit":1}\n');
  writeFileSync(logPath(root), '');
  appendEvent(root, { type: 'operation.logged', actor: 'owner', subject: null, payload: { operation: 'note' } });
  const last = readFileSync(logPath(root), 'utf8').trimEnd().split('\n').at(-1);
  const future = JSON.stringify({ id: '01JZZZZZZZZZZZZZZZZZZZZZZZ', ts: '2026-11-01T10:00:00.000-05:00', type: 'future.thing', actor: 'system', subject: null, payload: { level: 'observed' }, prev: sha(last) });
  appendFileSync(logPath(root), `${future}\n`);
  return root;
}

test('appending a known event succeeds after an event of an unknown type, and the chain stays intact', () => {
  const root = logWithUnknownType();
  const { line } = appendEvent(root, { type: 'role.declared', actor: 'executor', subject: null, payload: { role: 'executor', source: 'startup' } });
  assert.equal(line, 3);
  const vl = aos(root, ['verify-log']);
  assert.equal(vl.status, 0, vl.stdout);
  assert.match(vl.stdout, /3 lines, hash chain intact/);
  // The session-start hook records its role.declared too.
  const hook = aos(root, ['hook', 'session-start'], JSON.stringify({ session_id: 's', source: 'startup', cwd: root }));
  assert.equal(hook.status, 0);
  assert.doesNotMatch(hook.stdout, /role\.declared was not recorded/);
  // AMD-0007 §2: the role first, then the session.
  assert.deepEqual(readLog(root).events.slice(-2).map((e) => e.type), ['role.declared', 'session.start']);
});

test('aos validate still reports the unknown type (full validation is unchanged)', () => {
  const root = logWithUnknownType();
  const r = aos(root, ['validate']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /\.analucia\/events\.jsonl:2: E_TYPE_ENUM type "future\.thing" is not an event type/);
});

test('the new event itself is still validated, and a broken chain still refuses the append', () => {
  const root = logWithUnknownType();
  assert.throws(() => appendEvent(root, { type: 'future.thing', actor: 'system', subject: null, payload: {} }), (x) => x.code === 'E_TYPE_ENUM');
  assert.throws(() => appendEvent(root, { type: 'operation.logged', actor: 'robot', subject: null, payload: {} }), (x) => x.code === 'E_ACTOR_ENUM');
  const buf = readFileSync(logPath(root));
  writeFileSync(logPath(root), Buffer.from(buf.toString('utf8').replace('"note"', '"edit"')));
  assert.throws(() => appendEvent(root, { type: 'operation.logged', actor: 'owner', subject: null, payload: { operation: 'x' } }), (x) => x.code === 'E_CHAIN');
});

test('the plugin version reads 0.3.0 everywhere it is declared', () => {
  const plugin = fileURLToPath(new URL('..', import.meta.url));
  assert.equal(JSON.parse(readFileSync(join(plugin, '.claude-plugin', 'plugin.json'), 'utf8')).version, '0.3.0');
  const index = readFileSync(join(plugin, 'docs', 'INDEX.md'), 'utf8').split(/\r?\n/); // a CRLF checkout (core.autocrlf) is the same file
  assert.equal(index[0], 'analucia docs for plugin version 0.3.0');
  assert.match(index[2], /plugin `analucia` 0\.3\.0$/);
  assert.match(readFileSync(join(plugin, 'README.md'), 'utf8'), /version 0\.3\.0\./);
});
