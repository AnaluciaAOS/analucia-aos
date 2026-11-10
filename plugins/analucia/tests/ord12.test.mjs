// ORD-0012: deterministic evaluations (aos eval run) and one timestamp format.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runEvals, sandbox } from '../lib/evals.mjs';
import { readLog } from '../lib/log.mjs';
import { validateFile } from '../lib/validate.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const ONE_FORM = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/;

test('aos eval run: every scenario passes, one line each, a total, the view and an eval.run event', () => {
  const root = sandbox.project();
  const r = sandbox.aos(root, ['eval', 'run']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = r.stdout.trim().split('\n');
  const scenarios = lines.filter((l) => /^(PASS|FAIL) /.test(l));
  assert.ok(scenarios.length >= 7, `${scenarios.length} scenarios`);
  assert.ok(scenarios.every((l) => l.startsWith('PASS ')), r.stdout);
  for (const name of ['executor-closes-own-order', 'commit-without-trailer', 'secret-in-tracked-file', 'session-ends-with-open-run', 'director-file-edited', 'high-without-rollback', 'missing-risk']) {
    assert.ok(scenarios.includes(`PASS ${name}`), name);
  }
  assert.match(r.stdout, new RegExp(`total: ${scenarios.length} of ${scenarios.length} passed`));
  assert.match(readFileSync(join(root, '.analucia', 'views', 'evals.md'), 'utf8'), /^# aos eval run — /);
  const e = readLog(root).events.at(-1);
  assert.deepEqual([e.type, e.actor, e.payload.level, e.payload.total, e.payload.failed], ['eval.run', 'system', 'observed', scenarios.length, 0]);
  assert.equal(sandbox.aos(root, ['validate']).status, 0);
});

test('a scenario whose result differs from its expectation is reported as FAIL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aos-evals-'));
  writeFileSync(join(dir, 'x.eval.mjs'), `export default { name: 'wrong-expectation', description: 'expects success from a refused command', expect: [{ exit: 0 }],
    async run(sb) { const root = sb.project(); return [sb.aos(root, ['run', 'start', 'ORD-0009'])]; } };\n`);
  const [r] = await runEvals({ dir });
  assert.equal(r.passed, false);
  assert.deepEqual(r.checks[0].got, { exit: 1, code: 'E_NO_ORDER' });
});

test('one time format: with the machine clock in UTC, no command writes +00:00 when the project has a time zone', () => {
  const root = sandbox.project({ orders: [{ id: 'ORD-0001' }, { id: 'ORD-0002', keys: ['risk: low', 'cost_effect: none'] }], pinned: false });
  const pj = JSON.parse(readFileSync(join(root, '.analucia', 'project.json'), 'utf8'));
  writeFileSync(join(root, '.analucia', 'project.json'), `${JSON.stringify({ ...pj, timezone: 'America/Lima', wip_limit: 3 })}\n`);
  const utc = { ...process.env, TZ: 'UTC' };
  delete utc.CLAUDE_PROJECT_DIR;
  const run = (...args) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', env: utc, input: '' });
  // A pinned low order, so the director-close path (the one that wrote +00:00) is exercised.
  const lockPath = join(root, '.analucia', 'director.lock');
  assert.equal(run('event', 'append', '--type', 'operation.logged', '--actor', 'owner', '--subject', 'null', '--payload', '{"operation":"note"}').status, 0);
  for (const args of [['run', 'start', 'ORD-0001'], ['run', 'finish', 'ORD-0001', '--outcome', 'done', '--evidence', '.analucia/evidence/report.md'], ['verify', 'ORD-0001'],
    ['cost', 'record', '--usd', '1', '--source', 'test'], ['role', 'declare', 'director', '--scope', 'core/*.md'], ['eval', 'run']]) {
    const r = run(...args);
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
  }
  const hookStart = spawnSync(process.execPath, [AOS, 'hook', 'session-start', '--root', root], { encoding: 'utf8', env: utc, input: JSON.stringify({ session_id: 's', source: 'startup', cwd: root }) });
  assert.equal(hookStart.status, 0);
  assert.ok(readFileSync(lockPath, 'utf8'));
  const events = readLog(root).events;
  assert.ok(events.length > 10);
  for (const e of events.slice(6)) {
    assert.match(e.ts, ONE_FORM, `${e.type}: ${e.ts}`);
    assert.ok(e.ts.endsWith('-05:00'), `${e.type} wrote ${e.ts}`);
  }
  const verifyReport = readFileSync(join(root, '.analucia', 'evidence', 'ORD-0001', 'verify-01.txt'), 'utf8');
  assert.match(verifyReport, /at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}-05:00/);
});

test('director close --as director writes the project offset, not +00:00, on a UTC machine', async () => {
  const root = sandbox.project({ pinned: true, orders: [{ id: 'ORD-0001', keys: ['risk: low', 'cost_effect: none'] }] });
  const pj = JSON.parse(readFileSync(join(root, '.analucia', 'project.json'), 'utf8'));
  writeFileSync(join(root, '.analucia', 'project.json'), `${JSON.stringify({ ...pj, timezone: 'America/Lima' })}\n`);
  sandbox.deliver(root, 'ORD-0001', { verify: true });
  const utc = { ...process.env, TZ: 'UTC' };
  delete utc.CLAUDE_PROJECT_DIR;
  const r = spawnSync(process.execPath, [AOS, 'close', 'ORD-0001', '--as', 'director', '--root', root], { encoding: 'utf8', env: utc, input: '' });
  assert.equal(r.status, 0, r.stderr);
  const last = readLog(root).events.at(-1);
  assert.equal(last.payload.to, 'closed');
  assert.match(last.ts, ONE_FORM);
  assert.ok(last.ts.endsWith('-05:00'), last.ts);
});

test('project.json timezone must be an IANA zone', () => {
  const root = sandbox.project();
  const p = join(root, '.analucia', 'project.json');
  writeFileSync(p, '{"wip_limit":1,"timezone":"Mars/Olympus"}\n');
  assert.deepEqual(validateFile(p).map((e) => e.code), ['E_FIELD_TYPE']);
  writeFileSync(p, '{"wip_limit":1,"timezone":"Asia/Kolkata"}\n');
  assert.deepEqual(validateFile(p), []);
});
