// aos status, the chain from the decision to the outcome, and the metric (ORD-0042 part 6, OBS-158).
// Everything here is read from the event log: nothing is estimated, and nothing is invented for an order that has
// no recorded decision.
import { nextActionBy } from './owner-sheet.mjs';
import { directorName, sessionName } from './session-names.mjs';
import { replay } from './state.mjs';

// The links of the chain, in order. The JSON form of `aos status <ID> --chain --json` uses these names in every locale.
export const CHAIN_LINKS = ['decision', 'placed', 'admitted', 'run', 'evidence', 'outcome', 'verified', 'signed'];

// The decision an order carries out: the first decision.recorded that names it (as subject or in payload.orders).
export function decisionOf(events, id) {
  const i = events.findIndex((e) => e.type === 'decision.recorded' && (e.subject === id || (Array.isArray(e.payload?.orders) && e.payload.orders.includes(id))));
  return i === -1 ? null : { index: i, event: events[i] };
}

// [{ link, ts, detail? }] for one order: decision → placed → admitted → each run → its evidence → its outcome →
// verified → signed. Only links the log has.
export function chainOf(events, id) {
  const out = [];
  const d = decisionOf(events, id);
  if (d) out.push({ link: 'decision', ts: d.event.ts, detail: d.event.payload?.text ?? '' });
  const mine = events.filter((e) => e.subject === id);
  const created = mine.find((e) => e.type === 'record.created');
  if (created) out.push({ link: 'placed', ts: created.ts });
  const admitted = mine.find((e) => e.type === 'order.state_changed' && e.payload?.to === 'queued');
  if (admitted) out.push({ link: 'admitted', ts: admitted.ts });
  // Each run with the evidence the executor attached for it and its outcome.
  let run = null;
  const flush = () => {
    if (!run) return;
    out.push({ link: 'run', ts: run.started.ts, detail: `run ${run.started.payload?.run ?? '?'}` });
    if (run.evidence) out.push({ link: 'evidence', ts: run.evidence.ts, detail: run.evidence.payload?.path ?? '' });
    if (run.finished) out.push({ link: 'outcome', ts: run.finished.ts, detail: run.finished.payload?.outcome ?? '' });
    run = null;
  };
  for (const e of mine) {
    if (e.type === 'run.started') { flush(); run = { started: e }; }
    else if (run && e.type === 'run.finished' && !run.finished) run.finished = e;
    else if (run && e.type === 'evidence.attached' && e.actor !== 'system' && !run.evidence) run.evidence = e;
  }
  flush();
  const verified = mine.filter((e) => e.type === 'order.state_changed' && e.payload?.to === 'verified').at(-1);
  if (verified) out.push({ link: 'verified', ts: verified.ts });
  const signed = mine.find((e) => e.type === 'order.state_changed' && e.payload?.to === 'closed');
  if (signed) out.push({ link: 'signed', ts: signed.ts });
  return out;
}

// The metric of one order, or null when no decision was recorded for it: { decision, first_run, minutes,
// owner_steps }. `minutes` from decision.recorded to the first run.started (null while no run started);
// `owner_steps`: the owner's steps from the decision to that run. One step is one moment of the owner: his events
// with the same timestamp are one command he ran.
export function metricOf(events, id) {
  const d = decisionOf(events, id);
  if (!d) return null;
  const r = events.findIndex((e) => e.subject === id && e.type === 'run.started');
  const end = r === -1 ? events.length - 1 : r;
  const from = Math.min(d.index, end);
  const steps = new Set(events.slice(from, Math.max(d.index, end) + 1).filter((e) => e.actor === 'owner').map((e) => e.ts));
  const minutes = r === -1 ? null : Math.round((Date.parse(events[r].ts) - Date.parse(d.event.ts)) / 60000);
  return { decision: d.event.ts, first_run: r === -1 ? null : events[r].ts, minutes, owner_steps: steps.size };
}

// ORD-0042 part 11 (OBS-159): what the log knows about the work an order took. A hook receives no token or cost
// figure in its input, so tokens are not known (null): only sessions, runs and the minutes of the finished runs.
export function consumptionOf(events, id) {
  const sessions = new Set(events.filter((e) => e.type === 'session.start' && (e.payload?.order === id || e.subject === id)).map((e) => e.payload?.session ?? e.agent?.session).filter(Boolean));
  let runs = 0;
  let ms = 0;
  let open = null;
  for (const e of events) {
    if (e.subject !== id) continue;
    if (e.type === 'run.started') { runs += 1; open = e; }
    if (e.type === 'run.finished' && open) { ms += Math.max(0, Date.parse(e.ts) - Date.parse(open.ts)); open = null; }
  }
  return { sessions: sessions.size, runs, minutes: Math.round(ms / 60000), open_run: open !== null, tokens: null };
}

// ORD-0043 part 2: the checks of form the owner waived when he signed an order (from the payload of owner.signed).
export const waiversOf = (events, id) => events.filter((e) => e.type === 'owner.signed').flatMap((e) => (Array.isArray(e.payload?.waived) ? e.payload.waived : [])).filter((w) => w.order === id);
// Every order closed with waivers: [{ id, n }], by id.
export function waivedOrders(events) {
  const n = new Map();
  for (const e of events) if (e.type === 'owner.signed' && Array.isArray(e.payload?.waived)) for (const w of e.payload.waived) n.set(w.order, (n.get(w.order) ?? 0) + 1);
  return [...n.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, count]) => ({ id, n: count }));
}

// "2 d 3 h", "2 h 15 min", "30 min".
export function span(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min >= 2880) return `${Math.floor(min / 1440)} d ${Math.floor((min % 1440) / 60)} h`;
  if (min >= 60) return `${Math.floor(min / 60)} h ${min % 60} min`;
  return `${min} min`;
}

// Who holds an order, with the session when the log knows it: { who, session, name }.
export function holderOf(root, events, id, order) {
  const who = nextActionBy(order);
  let session = null;
  if (order.state === 'active') {
    const started = events.filter((e) => e.subject === id && e.type === 'run.started').at(-1);
    session = typeof started?.agent?.session === 'string' ? started.agent.session : null;
  }
  return { who, session, name: session ? sessionName(root, session, events) : who === 'director' ? directorName(root) : null };
}

// The stages a closed (or any) order went through, with how long each took: [{ state, ms }].
export function stagesOf(events, id) {
  const changes = events.filter((e) => e.subject === id && e.type === 'order.state_changed');
  const out = [];
  for (let i = 0; i + 1 < changes.length; i++) {
    const ms = Date.parse(changes[i + 1].ts) - Date.parse(changes[i].ts);
    const state = changes[i].payload.to;
    const last = out.at(-1);
    if (last && last.state === state) last.ms += ms;
    else out.push({ state, ms });
  }
  // The same stage visited twice (two runs) is added up.
  const merged = [];
  for (const s of out) {
    const have = merged.find((m) => m.state === s.state);
    if (have) have.ms += s.ms;
    else merged.push({ ...s });
  }
  return merged.filter((s) => s.ms >= 0 && !['draft', 'ready'].includes(s.state));
}

// One entry per order that is not closed (or the one asked for): what `aos status` prints.
export function statusOf(root, events, { now = new Date() } = {}) {
  const orders = replay(events).orders;
  return Object.keys(orders).sort().map((id) => {
    const o = orders[id];
    const holder = holderOf(root, events, id, o);
    return { id, state: o.state, holder, why: o.blocked_by && o.blocked_by !== o.reason ? `${o.reason ?? ''} (${o.blocked_by})`.trim() : o.reason ?? null, since: o.since, for_ms: now.getTime() - Date.parse(o.since) };
  });
}
export const TERMINAL = new Set(['closed', 'rejected', 'superseded', 'cancelled']);
