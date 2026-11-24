// ORD-0046 part 5 (option B, AMD-0027): the dispatcher. It reads the state the way `aos next` does and acts only on steps
// that are not the owner's: it places and admits a draft of risk low or medium whose decision the log already holds,
// verifies a delivered order (`aos verify` is the system's), and works out the next run: the session's name, the model
// and effort of its role (`routeFor`) and the brief generated from the order. It opens nothing and calls no command
// line: the executor that ends a run proposes the next session through the application's new-session card, and the
// owner clicks it (one click per run). It never signs, closes, merges or places a high-risk draft.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { aosCommand } from './cli.mjs';
import { draftDecision, listDrafts, orderKey, placeDrafts } from './drafts.mjs';
import { findRoot, openRuns } from './guards.mjs';
import { handoffRel } from './handoff.mjs';
import { verify } from './lifecycle.mjs';
import { logPath, readLog, verifyChain } from './log.mjs';
import { nextStep } from './next.mjs';
import { RuleError, replay } from './state.mjs';
import { parseFrontMatter } from './validate.mjs';

// ---------- the routing rule (one place, with tests) ----------
export const MODELS = { sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', haiku: 'claude-haiku-5-5' };
// Executor: Sonnet at medium effort; Opus at high effort only for a migration; readers of logs and tests: Haiku.
// The top model is never a default and no role maps to it.
export function routeFor({ role = 'executor', kind = null } = {}) {
  if (role === 'reader') return { model: MODELS.haiku, effort: 'low' };
  if (role === 'executor') return kind === 'migration' ? { model: MODELS.opus, effort: 'high' } : { model: MODELS.sonnet, effort: 'medium' };
  throw new RuleError('E_FIELD_TYPE', `the dispatcher opens sessions for the executor and for readers, not for "${role}"`);
}

// ---------- one at a time: the lock outside git ----------
export const lockPath = (root) => join(root, '.analucia', 'views', 'dispatch.lock');
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (x) { return x.code === 'EPERM'; }
};
export function readDispatchLock(root) {
  try { return JSON.parse(readFileSync(lockPath(root), 'utf8')); } catch { return null; }
}
// { ok: true, stale } or { ok: false, pid }: a lock of a dead process does not stop the next start.
export function acquire(root, extra = {}) {
  const held = readDispatchLock(root);
  if (held && held.pid !== process.pid && alive(held.pid)) return { ok: false, pid: held.pid };
  mkdirSync(join(root, '.analucia', 'views'), { recursive: true });
  writeFileSync(lockPath(root), `${JSON.stringify({ pid: process.pid, started: new Date().toISOString(), ...extra })}\n`);
  return { ok: true, stale: held && held.pid !== process.pid ? held : null };
}
export const release = (root) => rmSync(lockPath(root), { force: true });

// ---------- placing drafts the owner already decided ----------
const draftRisk = (root, d) => {
  try { return parseFrontMatter(readFileSync(join(root, d.order), 'utf8')).fields.get('risk')?.value ?? null; } catch { return null; }
};
// A decision.recorded of the project's people (the owner's decision, recorded by the director) whose text equals the
// `decision:` line of the draft, for that order ID. An executor's or a system's event never counts.
export function decisionMatches(events, id, text) {
  return Boolean(text) && events.some((e) => e.type === 'decision.recorded' && (e.actor === 'owner' || e.actor === 'director')
    && (e.subject === id || (Array.isArray(e.payload?.orders) && e.payload.orders.includes(id))) && e.payload?.text === text);
}
export function placeableDrafts(root, events) {
  return listDrafts(root).filter((d) => {
    if (!d.ok || !['low', 'medium'].includes(draftRisk(root, d))) return false;
    const text = orderKey(readFileSync(join(root, d.order), 'utf8'), 'decision');
    // AMD-0029: a draft named by topic is matched on the decision recorded for its topic (it has no number yet).
    return d.topic ? Boolean(text) && Boolean(draftDecision(events, d.topic, text)) : decisionMatches(events, d.id, text);
  });
}
function placeAndCommit(root, ids, now) {
  const r = placeDrafts(root, { ids, now, by: 'dispatcher' });
  if (r.placed.length && spawnSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).stdout.trim() === 'true') {
    const paths = ['.analucia/events.jsonl', '.analucia/director.lock', ...r.placed.flatMap((id) => [`.analucia/orders/${id}.md`, `.analucia/verify/${id}.json`])];
    spawnSync('git', ['-C', root, 'add', '--', ...paths], { encoding: 'utf8' });
    spawnSync('git', ['-C', root, 'commit', '-q', '-F', '-', '--', ...paths], { input: `Dispatcher: ${r.placed.join(', ')} placed (owner decision recorded)\n`, encoding: 'utf8' });
  }
  return r;
}

// ---------- the brief: generated from the order, never written by a person ----------
const ACT = {
  'next.queued': { first: (v) => `run start ${v.id}` },
  'next.queued_parts_cap': { first: (v) => `run start ${v.id}` },
  'next.rework': { first: (v) => `run start ${v.id}` },
  'next.block_ended': { first: (v) => `resume-order ${v.id} --reason "<why the block has ended>"` },
  'next.take_run': { first: (v) => `run take ${v.id}` },
};
const orderIdOf = (v) => String(v.id).split(' ')[0];
const orderKind = (root, id) => {
  try { return parseFrontMatter(readFileSync(join(root, '.analucia', 'orders', `${id}.md`), 'utf8')).fields.get('kind')?.value ?? null; } catch { return null; }
};
const dependsOf = (root, id) => {
  try { const v = parseFrontMatter(readFileSync(join(root, '.analucia', 'orders', `${id}.md`), 'utf8')).fields.get('depends_on')?.value; return Array.isArray(v) ? v : []; } catch { return []; }
};
export function briefFor(root, step) {
  const id = orderIdOf(step.vars);
  const aos = aosCommand();
  const first = ACT[step.key].first({ ...step.vars, id });
  return [
    `You are the executor of this project (rules: AGENTS.md). Work only on ${id}, by its ID. One run, one outcome.`,
    `1. Read .analucia/orders/${id}.md, its amendments (.analucia/amendments/), .analucia/verify/${id}.json and .analucia/evidence/${id}/report.md${step.key === 'next.take_run' ? `, and ${handoffRel(id)}` : ''}.`,
    `2. Your first command: ${aos} ${first}`,
    `3. Do the work; commit and push at the end of each part; every code commit ends with the trailer line "Analucia-Order: ${id}".`,
    `4. Write .analucia/evidence/${id}/report.md, run "${aos} report check ${id}", then "${aos} run finish ${id} --outcome <outcome> --evidence .analucia/evidence/${id}/report.md".`,
    `5. After "run finish", if "${aos} dispatch --brief" names a next run, propose that session through the application's new-session card (its name, model and brief); the owner clicks it. Never start a run yourself.`,
    'Never run aos verify, aos close or aos sign; never edit director files; never skip a permission. A denied command is not worked around: finish blocked or needs_decision.',
  ].join('\n');
}

// ---------- what to do next ----------
// { action, ... } without changing anything. action: halt | broken_log | verify | place | session | wait | idle | owner.
export function planNext(root, { session = null } = {}) {
  if (existsSync(join(root, '.analucia', 'HALT'))) return { action: 'halt' };
  if (!existsSync(logPath(root))) return { action: 'idle' };
  if (verifyChain(readFileSync(logPath(root)))) return { action: 'broken_log' };
  const { events } = readLog(root);
  const orders = replay(events).orders;
  const delivered = Object.keys(orders).filter((id) => orders[id].state === 'delivered').sort();
  if (delivered.length) return { action: 'verify', ids: delivered };
  const ready = placeableDrafts(root, events).map((d) => d.id);
  if (ready.length) return { action: 'place', ids: ready };
  const step = nextStep(root, { explicit: true, session });
  if (step.who === 'owner') return { action: 'owner', step };
  if (step.who !== 'executor' || !ACT[step.key] && step.key !== 'next.open_run') return { action: 'idle', step };
  if (step.key === 'next.open_run') {
    // An open run is taken only when its session ended; otherwise another session works on it and nothing is proposed.
    const open = openRuns(events)[0];
    const ended = open?.session && events.some((e) => e.type === 'session.end' && e.payload?.session === open.session);
    if (!ended) return { action: 'wait', step, why: 'run_open' };
    return { action: 'session', step: { ...step, key: 'next.take_run', vars: { ...step.vars, session: open.session ?? '' } }, take: true };
  }
  // A dependency that is not done blocks the start.
  const id = orderIdOf(step.vars);
  const open = dependsOf(root, id).filter((d) => orders[d] && !['closed', 'rejected', 'superseded', 'cancelled'].includes(orders[d].state));
  if (open.length) return { action: 'wait', step, why: 'dependency', deps: open };
  return { action: 'session', step };
}

// ---------- the next run, for the owner's click ----------
// { name, model, effort, order, run, take, brief } for a plan of action "session".
export function proposalFor(root, plan) {
  const id = orderIdOf(plan.step.vars);
  const route = routeFor({ role: 'executor', kind: orderKind(root, id) });
  const run = Number(plan.step.vars.run) || readLog(root).events.filter((e) => e.type === 'run.started' && e.subject === id).length + 1;
  return { name: `${id} run ${run}`, ...route, order: id, run, take: plan.take === true, brief: briefFor(root, plan.step) };
}

// ---------- the loop ----------
// Does what is the dispatcher's (verify, place) and stops at the first step that is not. Never opens a session.
// Returns { stopped, did, next }: next is the proposal of the next run when that is what comes.
export function dispatch(root, { now = () => new Date(), dryRun = false, maxSteps = 20 } = {}) {
  const did = [];
  const first = planNext(root);
  if (first.action === 'halt' || first.action === 'broken_log') return { stopped: first.action, did };
  const got = acquire(root);
  if (!got.ok) return { stopped: 'busy', pid: got.pid, did };
  try {
    for (let i = 0; i < maxSteps; i += 1) {
      const plan = planNext(root);
      if (plan.action === 'verify') {
        if (dryRun) { did.push({ would_verify: plan.ids }); return { stopped: 'dry_run', did }; }
        for (const id of plan.ids) {
          try { verify(root, id, { now: now() }); did.push({ verified: id }); } catch (x) { did.push({ verify_failed: id, code: x.code ?? 'error' }); return { stopped: 'verify_failed', did }; }
        }
        continue;
      }
      if (plan.action === 'place') {
        if (dryRun) { did.push({ would_place: plan.ids }); return { stopped: 'dry_run', did }; }
        const r = placeAndCommit(root, plan.ids, now());
        did.push({ placed: r.placed, refused: r.refused.map((x) => x.id) });
        if (!r.placed.length) return { stopped: 'place_refused', did };
        continue;
      }
      if (plan.action === 'session') return { stopped: 'next_run', did, next: proposalFor(root, plan) };
      return { stopped: plan.action, step: plan.step, did };
    }
    return { stopped: 'max_steps', did };
  } finally {
    release(root);
  }
}

export { findRoot };
