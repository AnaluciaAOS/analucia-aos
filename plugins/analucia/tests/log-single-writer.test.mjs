// ORD-0040 part 1: one writer for the event log. Any number of simultaneous writers leaves an intact chain and
// every event written; a lock left by a dead process does not stop the next writer; a writer that cannot get its
// turn within the bounded wait fails with E_LOG_BUSY and writes nothing, and the session-end hook still exits 0.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LOG_LOCK_REL, appendEvent, logLockPath, logPath, verifyChain } from '../lib/log.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'aos-writer-'));
  mkdirSync(join(root, '.analucia'));
  writeFileSync(logPath(root), '');
  writeFileSync(join(root, '.analucia', 'project.json'), JSON.stringify({ wip_limit: 1 }));
  return root;
}
const lines = (root) => readFileSync(logPath(root), 'utf8').split('\n').filter(Boolean);
const hook = (root, i, env = {}) => new Promise((res) => {
  const p = spawn(process.execPath, [AOS, 'hook', 'session-end'], { cwd: root, env: { ...process.env, CLAUDE_PROJECT_DIR: root, ...env }, stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  p.stderr.on('data', (d) => { stderr += d; });
  p.stdin.end(JSON.stringify({ session_id: `s${i}`, reason: 'other' }));
  p.on('close', (status) => res({ status, stderr }));
});
// A process id that is certainly not running: a child that has already exited.
const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid;
const lockBody = (pid) => JSON.stringify({ pid, host: hostname(), token: `${pid}.test`, at: Date.now() });

test('24 simultaneous writers from separate processes: every event is written and the chain is intact', async () => {
  const N = 24;
  for (let trial = 1; trial <= 2; trial++) {
    const root = scratch();
    const done = await Promise.all(Array.from({ length: N }, (_, i) => hook(root, i)));
    assert.deepEqual(done.map((d) => d.status), Array(N).fill(0), `trial ${trial}: every hook exits 0`);
    assert.equal(lines(root).length, N, `trial ${trial}: ${N} events written`);
    assert.equal(verifyChain(readFileSync(logPath(root))), null, `trial ${trial}: chain intact`);
    assert.equal(new Set(lines(root).map((l) => JSON.parse(l).payload.session)).size, N, `trial ${trial}: one event per writer`);
    assert.equal(existsSync(logLockPath(root)), false, `trial ${trial}: no lock left behind`);
  }
});

test('a stale lock does not stop the next writer: dead process, or a lock older than the stale age', () => {
  const root = scratch();
  writeFileSync(logLockPath(root), lockBody(deadPid()));
  appendEvent(root, { type: 'role.declared', actor: 'executor', payload: { role: 'executor' } }, { lockWaitMs: 6000 });
  assert.equal(lines(root).length, 1, 'written after a lock left by a dead process');
  assert.equal(existsSync(logLockPath(root)), false);

  // A live process id, but the lock is far older than any append takes (process id reused, or another machine).
  writeFileSync(logLockPath(root), lockBody(process.pid));
  const old = new Date(Date.now() - 10 * 60 * 1000);
  utimesSync(logLockPath(root), old, old);
  appendEvent(root, { type: 'role.declared', actor: 'executor', payload: { role: 'executor' } }, { lockWaitMs: 6000 });
  assert.equal(lines(root).length, 2, 'written after an old lock');

  // An unreadable (empty) old lock is stale too.
  writeFileSync(logLockPath(root), '');
  utimesSync(logLockPath(root), old, old);
  appendEvent(root, { type: 'role.declared', actor: 'executor', payload: { role: 'executor' } }, { lockWaitMs: 6000 });
  assert.equal(lines(root).length, 3);
  assert.equal(verifyChain(readFileSync(logPath(root))), null);
  assert.equal(existsSync(logLockPath(root)), false);
});

test('a writer that cannot get its turn fails with E_LOG_BUSY and writes nothing; the session-end hook still exits 0', async () => {
  const root = scratch();
  appendEvent(root, { type: 'role.declared', actor: 'executor', payload: { role: 'executor' } });
  const before = readFileSync(logPath(root));
  // The lock is held by a live process (this one) and is fresh: nobody may take it.
  writeFileSync(logLockPath(root), lockBody(process.pid));
  const t0 = Date.now();
  assert.throws(
    () => appendEvent(root, { type: 'role.declared', actor: 'executor', payload: { role: 'executor' } }, { lockWaitMs: 300 }),
    (x) => x.code === 'E_LOG_BUSY' && x.message.includes(LOG_LOCK_REL),
  );
  assert.ok(Date.now() - t0 < 5000, 'the wait is bounded');
  assert.deepEqual(readFileSync(logPath(root)), before, 'nothing written');
  assert.ok(existsSync(logLockPath(root)), 'the holder keeps its lock');

  const h = await hook(root, 1, { AOS_LOG_LOCK_WAIT_MS: '300' });
  assert.equal(h.status, 0, 'the hook never blocks the end of the session');
  assert.match(h.stderr, /session\.end was not recorded \(E_LOG_BUSY/);
  assert.deepEqual(readFileSync(logPath(root)), before, 'nothing written by the hook');

  // The CLI names the code and its next step.
  const r = spawnSync(process.execPath, [AOS, 'event', 'append', '--type', 'role.declared', '--actor', 'executor', '--payload', '{"role":"executor"}', '--root', root], { encoding: 'utf8', env: { ...process.env, AOS_LOG_LOCK_WAIT_MS: '300' } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /E_LOG_BUSY/);
  assert.match(r.stdout, /next \(executor\)/);
  assert.deepEqual(readFileSync(logPath(root)), before);
});
