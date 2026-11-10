import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildViews, derive } from '../lib/derive.mjs';
import { enums } from '../lib/enums.mjs';
import { appendEvent, logPath } from '../lib/log.mjs';
import { validateTree } from '../lib/validate.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const aos = (root, ...args) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8' });

function project({ wip = 1 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aos-test-'));
  mkdirSync(join(root, '.analucia', 'orders'), { recursive: true });
  writeFileSync(join(root, '.analucia', 'project.json'), `${JSON.stringify({ wip_limit: wip })}\n`);
  writeFileSync(logPath(root), '');
  return root;
}
const log = (root) => readFileSync(logPath(root));
const lineCount = (root) => log(root).toString('utf8').split('\n').length - 1;

let clock = Date.parse('2026-10-20T09:00:00Z');
const tick = () => new Date((clock += 1000));
const ev = (root, type, actor, subject, payload = {}, now = tick()) => appendEvent(root, { type, actor, subject, payload }, { now });
const actorFor = (to) => (to === 'closed' ? 'owner' : to === 'verified' ? 'system' : 'executor');
const FULL = { reason: 'test reason', blocked_by: 'ASK-0001', superseded_by: 'ORD-0099' };
const move = (root, id, from, to, extra = FULL, now) => ev(root, 'order.state_changed', actorFor(to), id, { from, to, ...extra }, now);

// Canonical way to bring an order into each state.
const PATHS = {
  draft: [],
  ready: ['ready'],
  queued: ['ready', 'queued'],
  active: ['ready', 'queued', 'active'],
  paused: ['ready', 'queued', 'active', 'paused'],
  blocked: ['ready', 'queued', 'active', 'blocked'],
  delivered: ['ready', 'queued', 'active', 'RUN_DONE', 'delivered'],
  verified: ['ready', 'queued', 'active', 'RUN_DONE', 'delivered', 'verified'],
  closed: ['ready', 'queued', 'active', 'RUN_DONE', 'delivered', 'verified', 'closed'],
  rejected: ['rejected'],
  superseded: ['superseded'],
  cancelled: ['cancelled'],
};
function bring(root, id, target) {
  ev(root, 'record.created', 'director', id);
  let cur = 'draft';
  for (const step of PATHS[target]) {
    if (step === 'RUN_DONE') {
      ev(root, 'run.started', 'executor', id);
      ev(root, 'run.finished', 'executor', id, { outcome: 'done' });
      continue;
    }
    move(root, id, cur, step);
    cur = step;
  }
}

// Transitions drawn in SPEC-0001 §4 (plus SPEC-0002 §3), written out independently of lib/state.mjs.
const LEGAL = new Set([
  'draft>ready', 'ready>queued', 'queued>active', 'active>delivered', 'delivered>verified', 'verified>closed',
  'active>paused', 'active>blocked', 'paused>active', 'blocked>active', 'delivered>active',
  'active>queued', // SPEC-0002 §3: budget_exhausted / failed return the order to queued
  ...['draft', 'ready', 'queued', 'active', 'paused', 'blocked'].flatMap((s) => [`${s}>rejected`, `${s}>superseded`, `${s}>cancelled`]),
]);

test('append + derive round trip', () => {
  const root = project();
  bring(root, 'ORD-0001', 'active');
  ev(root, 'run.started', 'executor', 'ORD-0001');
  ev(root, 'run.finished', 'executor', 'ORD-0001', { outcome: 'done' });
  ev(root, 'evidence.attached', 'executor', 'ORD-0001', { level: 'derived', path: '.analucia/evidence/ORD-0001/report.md' });
  move(root, 'ORD-0001', 'active', 'delivered', {});
  assert.equal(lineCount(root), 8);
  assert.deepEqual(validateTree(root), []);
  assert.equal(aos(root, 'verify-log').status, 0);
  const d = aos(root, 'derive');
  assert.equal(d.status, 0, d.stdout);
  const state = JSON.parse(readFileSync(join(root, '.analucia', 'views', 'state.json'), 'utf8'));
  const o = state.orders['ORD-0001'];
  assert.equal(o.state, 'delivered');
  assert.equal(o.runs, 1);
  assert.equal(o.last_outcome, 'done');
  assert.deepEqual(o.evidence, [{ path: '.analucia/evidence/ORD-0001/report.md', level: 'derived' }]);
  assert.equal(state.generated_from.lines, 8);
  const h = aos(root, 'history', 'ORD-0001');
  assert.equal(h.status, 0);
  assert.equal(h.stdout.trim().split('\n').length, 8);
  // Every line carries the hash of the previous one; the file only grew.
  const lines = log(root).toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].prev, null);
  assert.ok(lines.slice(1).every((e) => /^[0-9a-f]{64}$/.test(e.prev)));
});

test('every illegal transition is rejected with E_TRANSITION and writes nothing', () => {
  let illegal = 0;
  let legal = 0;
  for (const from of enums.order_states) {
    const root = project({ wip: 10 });
    bring(root, 'ORD-0001', from);
    for (const to of enums.order_states) {
      const key = `${from}>${to}`;
      if (LEGAL.has(key)) {
        const copy = mkdtempSync(join(tmpdir(), 'aos-legal-'));
        cpSync(root, copy, { recursive: true });
        if (to === 'delivered') {
          ev(copy, 'run.started', 'executor', 'ORD-0001');
          ev(copy, 'run.finished', 'executor', 'ORD-0001', { outcome: 'done' });
        }
        assert.doesNotThrow(() => move(copy, 'ORD-0001', from, to), key);
        legal++;
        continue;
      }
      const before = log(root);
      assert.throws(() => move(root, 'ORD-0001', from, to), (x) => x.code === 'E_TRANSITION', key);
      assert.deepEqual(log(root), before, `${key} changed the log`);
      illegal++;
    }
  }
  assert.equal(legal, LEGAL.size);
  assert.equal(illegal, enums.order_states.length ** 2 - LEGAL.size);
});

test('transition rules: actors, delivery, current state, required payload', () => {
  const root = project();
  bring(root, 'ORD-0001', 'delivered');
  const rejects = (fn, code, msg) => {
    const before = log(root);
    assert.throws(fn, (x) => x.code === code, msg);
    assert.deepEqual(log(root), before);
  };
  rejects(() => ev(root, 'order.state_changed', 'director', 'ORD-0001', { from: 'delivered', to: 'verified' }), 'E_TRANSITION', 'verified by director');
  rejects(() => ev(root, 'order.state_changed', 'executor', 'ORD-0001', { from: 'delivered', to: 'verified' }), 'E_TRANSITION', 'verified by executor');
  ev(root, 'order.state_changed', 'system', 'ORD-0001', { from: 'delivered', to: 'verified' });
  rejects(() => ev(root, 'order.state_changed', 'director', 'ORD-0001', { from: 'verified', to: 'closed' }), 'E_TRANSITION', 'closed by director');
  rejects(() => ev(root, 'order.state_changed', 'system', 'ORD-0001', { from: 'verified', to: 'closed' }), 'E_TRANSITION', 'closed by system');
  ev(root, 'order.state_changed', 'owner', 'ORD-0001', { from: 'verified', to: 'closed' });

  bring(root, 'ORD-0002', 'active');
  rejects(() => move(root, 'ORD-0002', 'active', 'delivered', {}), 'E_TRANSITION', 'delivered without run');
  ev(root, 'run.finished', 'executor', 'ORD-0002', { outcome: 'blocked' });
  rejects(() => move(root, 'ORD-0002', 'active', 'delivered', {}), 'E_TRANSITION', 'delivered after outcome blocked');
  rejects(() => move(root, 'ORD-0002', 'queued', 'active', {}), 'E_TRANSITION', 'from does not match current state');
  rejects(() => move(root, 'ORD-0009', 'draft', 'ready', {}), 'E_TRANSITION', 'unknown order');
  rejects(() => move(root, 'ORD-0002', 'active', 'paused', {}), 'E_PAUSED_NO_REASON', 'paused without reason');
  rejects(() => move(root, 'ORD-0002', 'active', 'blocked', { reason: 'x' }), 'E_BLOCKED_NO_REF', 'blocked without blocked_by');
  rejects(() => move(root, 'ORD-0002', 'active', 'blocked', { blocked_by: 'ASK-0001' }), 'E_TRANSITION', 'blocked without reason');
  rejects(() => move(root, 'ORD-0002', 'active', 'superseded', {}), 'E_SUPERSEDED_NO_REF', 'superseded without superseded_by');
  rejects(() => move(root, 'ORD-0002', 'active', 'casi listo', {}), 'E_STATE_ENUM', 'state outside the enum');
  rejects(() => ev(root, 'record.created', 'director', 'ORD-0001'), 'E_RECORD_EXISTS', 'ID reused');
});

test('wip_limit is enforced when entering active', () => {
  const root = project({ wip: 1 });
  bring(root, 'ORD-0001', 'active');
  bring(root, 'ORD-0002', 'queued');
  const before = log(root);
  assert.throws(() => move(root, 'ORD-0002', 'queued', 'active'), (x) => x.code === 'E_WIP_LIMIT');
  assert.deepEqual(log(root), before);
  move(root, 'ORD-0001', 'active', 'paused');
  assert.doesNotThrow(() => move(root, 'ORD-0002', 'queued', 'active'));
  assert.throws(() => move(root, 'ORD-0001', 'paused', 'active'), (x) => x.code === 'E_WIP_LIMIT');

  const two = project({ wip: 2 });
  bring(two, 'ORD-0001', 'active');
  bring(two, 'ORD-0002', 'active');
  bring(two, 'ORD-0003', 'queued');
  assert.throws(() => move(two, 'ORD-0003', 'queued', 'active'), (x) => x.code === 'E_WIP_LIMIT');
});

test('verify-log detects one edited byte in an old line (temp copy)', () => {
  const root = project();
  bring(root, 'ORD-0001', 'delivered');
  assert.equal(aos(root, 'verify-log').status, 0);
  const copy = mkdtempSync(join(tmpdir(), 'aos-tamper-'));
  cpSync(root, copy, { recursive: true });
  const buf = Buffer.from(log(copy));
  const lineStarts = [0, ...[...buf.keys()].filter((i) => buf[i] === 0x0a).map((i) => i + 1)];
  const at = buf.indexOf('"ready"', lineStarts[1]); // inside line 2
  assert.ok(at > lineStarts[1] && at < lineStarts[2]);
  buf[at + 5] = 'z'.charCodeAt(0); // "ready" -> "readz": one byte
  writeFileSync(logPath(copy), buf);
  const r = aos(copy, 'verify-log');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^\.analucia\/events\.jsonl:3: E_CHAIN prev does not match sha256 of line 2/);
});

test('derive is deterministic (byte-identical twice, and on a copy)', () => {
  const root = project();
  bring(root, 'ORD-0001', 'verified');
  bring(root, 'ORD-0002', 'blocked');
  ev(root, 'ask.opened', 'director', 'ASK-0001', { kind: 'decide', reason: 'pick one' });
  const a = derive(root);
  const s1 = readFileSync(join(root, '.analucia', 'views', 'state.json'));
  const r1 = readFileSync(join(root, '.analucia', 'views', 'resume.md'));
  derive(root);
  assert.deepEqual(readFileSync(join(root, '.analucia', 'views', 'state.json')), s1);
  assert.deepEqual(readFileSync(join(root, '.analucia', 'views', 'resume.md')), r1);
  const copy = mkdtempSync(join(tmpdir(), 'aos-copy-'));
  cpSync(root, copy, { recursive: true });
  const b = buildViews(copy);
  assert.equal(b.state, a.state);
  assert.equal(b.resume, a.resume);
});

test('resume.md: section order, oldest pending signatures first, at most 3 plus a count, under 60 lines', () => {
  const root = project({ wip: 1 });
  const at = (hhmm) => new Date(`2026-10-20T${hhmm}:00-05:00`);
  bring(root, 'ORD-0001', 'delivered');
  move(root, 'ORD-0001', 'delivered', 'verified', {}, at('10:02'));
  ev(root, 'ask.opened', 'director', 'ASK-0001', { kind: 'decide' }, at('10:03'));
  ev(root, 'ask.opened', 'director', 'ASK-0002', { kind: 'provide' }, at('10:01'));
  ev(root, 'ask.opened', 'director', 'ASK-0003', { kind: 'act' }, at('10:04'));
  ev(root, 'ask.opened', 'director', 'ASK-0004', { kind: 'sign' }, at('10:05'));
  ev(root, 'ask.resolved', 'owner', 'ASK-0004', { decision: 'approve', comment: '', via: 'sheet' }, at('10:06'));
  ev(root, 'ask.opened', 'director', 'ASK-0005', { kind: 'sign' }, at('10:07'));
  bring(root, 'ORD-0002', 'blocked');
  bring(root, 'ORD-0003', 'active');

  const lines = buildViews(root).resume.trimEnd().split('\n');
  assert.ok(lines.length < 60, `${lines.length} lines`);
  assert.match(lines[0], /^Status: 3 orders .* pending signatures 5 /);
  const idx = (h) => lines.findIndex((l) => l.startsWith(h));
  const order = ['## Pending signatures', '## Active order', '## Blocked', '## Last 10 events'].map(idx);
  assert.ok(order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1])), JSON.stringify(order));

  const pending = lines.slice(order[0] + 1, order[1]).filter((l) => l.startsWith('- '));
  assert.equal(pending.length, 4);
  assert.match(pending[0], /ASK-0002/);
  assert.match(pending[1], /ORD-0001 verified/);
  assert.match(pending[2], /ASK-0001/);
  assert.equal(pending[3], '- … and 2 more');
  assert.match(lines.slice(order[1], order[2]).join('\n'), /- ORD-0003 since /);
  assert.match(lines.slice(order[2], order[3]).join('\n'), /- ORD-0002 blocked by ASK-0001: test reason/);
  assert.equal(lines.slice(order[3] + 1).filter((l) => l.startsWith('- ')).length, 10);
});

test('CLI: queued -> closed exits 1 with E_TRANSITION and the line count does not change', () => {
  const root = project();
  bring(root, 'ORD-0001', 'queued');
  const before = lineCount(root);
  const r = aos(root, 'event', 'append', '--type', 'order.state_changed', '--actor', 'owner', '--subject', 'ORD-0001', '--payload', '{"from":"queued","to":"closed"}');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /E_TRANSITION transition queued -> closed is not allowed/);
  assert.equal(lineCount(root), before);
  const ok = aos(root, 'event', 'append', '--type', 'order.state_changed', '--actor', 'system', '--subject', 'ORD-0001', '--payload', '{"from":"queued","to":"active"}');
  assert.equal(ok.status, 0, ok.stdout);
  assert.equal(lineCount(root), before + 1);
});
