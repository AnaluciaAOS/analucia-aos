// ORD-0047 part 17 (OBS-215): the cost of each order is known. Tokens are read from a scratch copy of Claude Code's
// session records with made-up numbers: usage fields only, never message text, never another project's records;
// records missing -> "not known"; orders before the baseline order -> "not measured".
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { appendEvent, logPath } from '../lib/log.mjs';
import { readLog } from '../lib/log.mjs';
import { costLines, costSessions, projectFolderName, recordsDir, runSessions } from '../lib/session-cost.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const SECRET = 'the-text-of-a-prompt-that-must-never-be-read';

const line = (model, input, output, cc, cr, id, extra = {}) => JSON.stringify({ type: 'assistant', requestId: `req-${id}`, message: { id: `msg-${id}`, model, content: [{ type: 'text', text: SECRET }], usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: cc, cache_read_input_tokens: cr } }, ...extra });

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'aos-scost-'));
  const config = mkdtempSync(join(tmpdir(), 'aos-scost-cfg-'));
  mkdirSync(join(root, '.analucia'), { recursive: true });
  writeFileSync(join(root, '.analucia', 'project.json'), '{"wip_limit":1,"locale":"en"}\n');
  writeFileSync(logPath(root), '');
  const env = { CLAUDE_CONFIG_DIR: config };
  const dir = recordsDir(root, env);
  mkdirSync(dir, { recursive: true });
  const run = (order, n, session, ts) => appendEvent(root, { type: 'run.started', actor: 'executor', subject: order, payload: { run: n, budget: { max_minutes: 60, max_attempts: 3 } }, agent: { tool: 'claude-code', session } }, { now: new Date(ts) });
  run('ORD-0046', 1, S2, '2026-11-20T10:00:00.000Z'); // before the baseline order
  run('ORD-0047', 1, S1, '2026-11-21T10:00:00.000Z');
  run('ORD-0047', 2, S2, '2026-11-22T10:00:00.000Z');
  return { root, config, env, dir };
}

test('usage is summed by model per run and in all; a repeated message counts once; no message text is returned', () => {
  const { root, env, dir } = setup();
  writeFileSync(join(dir, `${S1}.jsonl`), [
    line('model-a', 10, 5, 100, 1000, 1),
    line('model-a', 10, 5, 100, 1000, 1), // the same message again
    line('model-a', 20, 7, 0, 500, 2),
    line('model-b', 1, 2, 3, 4, 3),
    JSON.stringify({ type: 'user', message: { role: 'user', content: SECRET } }),
    'not json "usage" at all',
  ].join('\n'));
  const r = costSessions(root, readLog(root).events, 'ORD-0047', { env });
  assert.equal(r.measured, true);
  assert.deepEqual(r.runs.map((x) => [x.run, x.session, x.found]), [[1, S1, true], [2, S2, false]]);
  assert.deepEqual(r.total['model-a'], { input: 30, output: 12, cache_creation: 100, cache_read: 1500, cost_usd: null, messages: 2 });
  assert.deepEqual(r.total['model-b'], { input: 1, output: 2, cache_creation: 3, cache_read: 4, cost_usd: null, messages: 1 });
  assert.ok(!JSON.stringify(r).includes(SECRET), 'no text of a message is in the result');
  assert.equal(r.cost_known, false);
  const text = costLines('ORD-0047', r).join('\n');
  assert.match(text, /run 2 \(session 2{8}-.*\): not known/, 'a session with no record is not known');
  assert.match(text, /the records carry no cost: tokens only/);
  assert.ok(!text.includes(SECRET));
});

test('a cost the records carry is summed and shown', () => {
  const { root, env, dir } = setup();
  writeFileSync(join(dir, `${S1}.jsonl`), [line('model-a', 1, 1, 0, 0, 1, { costUSD: 0.25 }), line('model-a', 1, 1, 0, 0, 2, { costUSD: 0.5 })].join('\n'));
  writeFileSync(join(dir, `${S2}.jsonl`), line('model-a', 1, 1, 0, 0, 3, { costUSD: 0.25 }));
  const r = costSessions(root, readLog(root).events, 'ORD-0047', { env });
  assert.equal(r.total['model-a'].cost_usd, 1);
  assert.equal(r.cost_known, true);
  assert.match(costLines('ORD-0047', r).join('\n'), /total model-a: .*cost \$1/);
});

test("another project's records are ignored: only this project's folder is read", () => {
  const { root, env, dir } = setup();
  const other = join(dir, '..', projectFolderName(`${root}-other`));
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, `${S1}.jsonl`), line('model-x', 999, 999, 999, 999, 9));
  writeFileSync(join(dir, `${S1}.jsonl`), line('model-a', 1, 2, 3, 4, 1));
  const r = costSessions(root, readLog(root).events, 'ORD-0047', { env });
  assert.deepEqual(Object.keys(r.total), ['model-a']);
});

test('records missing -> not known; orders before the baseline order -> not measured; the CLI prints both', () => {
  const { root, config } = setup();
  const env = { ...process.env, CLAUDE_CONFIG_DIR: config };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CLAUDE_CODE_SESSION_ID;
  const cli = (...a) => spawnSync(process.execPath, [AOS, ...a, '--root', root], { encoding: 'utf8', env });
  const a = cli('cost', 'sessions', 'ORD-0047');
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout, /run 1 .*: not known/);
  const b = cli('cost', 'sessions', 'ORD-0046');
  assert.match(b.stdout, /ORD-0046: not measured/);
  for (const o of ['ORD-0046', 'ORD-0047']) appendEvent(root, { type: 'record.created', actor: 'director', subject: o, payload: { pins: { plugin: '0.8.0', specs: {} } } });
  const m = cli('status', '--metric');
  assert.match(m.stdout, /tokens by model: not known/);
  assert.match(m.stdout, /tokens by model: not measured/);
});

test('sessions come from run.started and from the dispatcher\'s rows, each counted once', () => {
  const { root } = setup();
  appendEvent(root, { type: 'operation.logged', actor: 'system', subject: 'ORD-0047', payload: { operation: 'dispatch.session', session: '33333333-3333-4333-8333-333333333333', run: 3 } });
  appendEvent(root, { type: 'operation.logged', actor: 'system', subject: 'ORD-0047', payload: { operation: 'dispatch.session', session: S1, run: 1 } });
  const s = runSessions(readLog(root).events, 'ORD-0047');
  assert.deepEqual(s.map((x) => x.session), [S1, S2, '33333333-3333-4333-8333-333333333333']);
});
