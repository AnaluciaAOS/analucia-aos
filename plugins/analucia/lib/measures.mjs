// ORD-0046 part 6: three measures per order, from the log and the dispatcher's records. Nothing is estimated.
//   human touches  — the owner's moments from his decision to the signature (target 2)
//   active minutes — time inside the runs, a gap without activity longer than 15 minutes not counted (OBS-175)
//   cost by model  — what the command line reported for the sessions the dispatcher opened, summed per order and model
import { decisionOf } from './status.mjs';

export const TOUCH_TARGET = 2;
export const IDLE_GAP_MS = 15 * 60000;

// One touch is one moment of the owner: his events with the same timestamp are one command he ran. Null when the
// order has no recorded decision. Counts to the signature, or to now while the order is open.
export function touchesOf(events, id) {
  const d = decisionOf(events, id);
  if (!d) return null;
  const closed = events.findIndex((e, i) => i >= d.index && e.subject === id && e.type === 'order.state_changed' && e.payload?.to === 'closed');
  const end = closed === -1 ? events.length - 1 : closed;
  return new Set(events.slice(d.index, end + 1).filter((e) => e.actor === 'owner').map((e) => e.ts)).size;
}

// Inside a run the clock moves from one event of the log to the next; a gap longer than `gapMs` is not counted.
// An open run counts up to its last event.
export function activeMinutesOf(events, id, { gapMs = IDLE_GAP_MS } = {}) {
  let ms = 0;
  let last = null;
  for (const e of events) {
    const t = Date.parse(e.ts);
    if (last !== null) {
      if (t - last <= gapMs) ms += t - last;
      last = t;
    }
    if (e.subject === id && e.type === 'run.started') last = t;
    if (e.subject === id && e.type === 'run.finished') last = null;
  }
  return Math.round((ms / 60000) * 10) / 10;
}

// { <model>: usd }, or null ("not known") when no run of the order was opened by the dispatcher: a run opened by a
// person carries no cost figure.
export function costByModelOf(events, id) {
  const rows = events.filter((e) => e.type === 'operation.logged' && e.subject === id && e.payload?.operation === 'dispatch.session' && typeof e.payload.cost_usd === 'number');
  if (!rows.length) return null;
  const by = {};
  for (const e of rows) by[e.payload.model] = Math.round(((by[e.payload.model] ?? 0) + e.payload.cost_usd) * 10000) / 10000;
  return by;
}
