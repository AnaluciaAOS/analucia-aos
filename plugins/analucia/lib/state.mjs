// Derived state: replay of the event log, and the transition rules of SPEC-0001 §4.
import { enums } from './enums.mjs';

// Transitions drawn in SPEC-0001 §4, plus SPEC-0002 §3.
const DRAWN = {
  draft: ['ready'],
  ready: ['queued'],
  queued: ['active'],
  active: ['delivered', 'paused', 'blocked', 'queued'], // active -> queued: SPEC-0002 §3 (budget_exhausted, failed)
  paused: ['active'],
  blocked: ['active'],
  delivered: ['verified', 'active'], // delivered -> active is rework (counts as reopen, Q-61)
  verified: ['closed'],
};
// "Terminal without delivery": rejected, superseded, cancelled can be entered from any state before delivery.
const BEFORE_DELIVERY = ['draft', 'ready', 'queued', 'active', 'paused', 'blocked'];
const WITHOUT_DELIVERY = enums.terminal_states.filter((s) => s !== 'closed');

export const ALLOWED = Object.fromEntries(enums.order_states.map((s) => [
  s,
  [...(DRAWN[s] ?? []), ...(BEFORE_DELIVERY.includes(s) ? WITHOUT_DELIVERY : [])],
]));

export class RuleError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function emptyState() {
  return { orders: {}, asks: {}, records: {}, events: 0 };
}

// Check one event against the current derived state. Throws RuleError; never mutates.
// `directorMayClose`: order IDs that `aos close --as director` checked as risk: low (SPEC-0003 §4). Only close() passes it.
export function checkRules(state, e, { wipLimit = 1, directorMayClose = new Set() } = {}) {
  if (e.type === 'record.created' && e.subject && state.records[e.subject]) {
    throw new RuleError('E_RECORD_EXISTS', `record ${e.subject} was already created (IDs are never reused)`);
  }
  if (e.type === 'ask.opened' && state.asks[e.subject]) {
    throw new RuleError('E_RECORD_EXISTS', `ask ${e.subject} was already opened`);
  }
  // AMD-0007 §1: only the owner decides about a document under review.
  if (e.type === 'review.decision' && e.actor !== 'owner') {
    throw new RuleError('E_TRANSITION', 'a review is decided only by actor owner (in "aos sign")');
  }
  // SPEC-0004 §1: only the owner resolves an ask, once, with one of its options.
  if (e.type === 'ask.resolved') {
    const ask = state.asks[e.subject];
    if (!ask) throw new RuleError('E_TRANSITION', `ask ${e.subject} was never opened`);
    if (ask.status !== 'open') throw new RuleError('E_TRANSITION', `ask ${e.subject} is already resolved`);
    if (e.actor !== 'owner') throw new RuleError('E_TRANSITION', 'an ask is resolved only by actor owner');
    if (ask.options?.length && !ask.options.includes(e.payload.decision)) {
      throw new RuleError('E_TRANSITION', `decision ${JSON.stringify(e.payload.decision)} is not one of the ask's options: ${ask.options.join(', ')}`);
    }
    return;
  }
  if (e.type !== 'order.state_changed') return;

  const { from, to } = e.payload;
  const order = state.orders[e.subject];
  if (!order) throw new RuleError('E_TRANSITION', `order ${e.subject} has no record.created event`);
  if (order.state !== from) throw new RuleError('E_TRANSITION', `order ${e.subject} is "${order.state}", not "${from}"`);
  if (!ALLOWED[from].includes(to)) {
    throw new RuleError('E_TRANSITION', `transition ${from} -> ${to} is not allowed (SPEC-0001 §4)`);
  }
  if (to === 'closed' && e.actor !== 'owner' && !(e.actor === 'director' && directorMayClose.has(e.subject))) {
    throw new RuleError('E_TRANSITION', '"closed" can only be entered by actor owner (or by director through "aos close --as director" for risk: low)');
  }
  if (to === 'verified' && e.actor !== 'system') throw new RuleError('E_TRANSITION', '"verified" can only be entered by actor system');
  if (to === 'delivered' && order.last_outcome !== 'done') {
    throw new RuleError('E_TRANSITION', `"delivered" needs a run.finished with outcome done for ${e.subject} (last outcome: ${order.last_outcome ?? 'none'})`);
  }
  if (to === 'blocked' && !(typeof e.payload.reason === 'string' && e.payload.reason.trim())) {
    throw new RuleError('E_TRANSITION', '"blocked" requires payload.reason as well as payload.blocked_by');
  }
  if (to === 'active') {
    const active = Object.values(state.orders).filter((o) => o.state === 'active').length;
    if (active + 1 > wipLimit) throw new RuleError('E_WIP_LIMIT', `entering "active" would make ${active + 1} active orders; wip_limit is ${wipLimit}`);
  }
}

// Apply one (already accepted) event to the derived state. `line` is its 1-based line in the log.
export function applyEvent(state, e, line) {
  state.events = line;
  if (e.subject && (e.type === 'record.created' || e.type === 'ask.opened')) state.records[e.subject] = { created: e.ts, line };
  const order = () => state.orders[e.subject];
  switch (e.type) {
    case 'record.created':
      if (/^ORD-/.test(e.subject ?? '')) {
        state.orders[e.subject] = {
          state: 'draft', since: e.ts, created: e.ts, reason: null, blocked_by: null,
          runs: 0, last_outcome: null, evidence: [], amendments: [], reopens: 0, last_line: line,
        };
      }
      break;
    case 'record.amended':
      if (order()) {
        if (e.payload.amendment) order().amendments.push(e.payload.amendment);
        order().last_line = line;
      }
      break;
    case 'order.state_changed': {
      const o = order();
      if (!o) break;
      if (o.state === 'delivered' && e.payload.to === 'active') o.reopens++;
      if (e.payload.to === 'active') o.last_outcome = null;
      o.state = e.payload.to;
      o.since = e.ts;
      o.reason = e.payload.reason ?? null;
      o.blocked_by = e.payload.to === 'blocked' ? e.payload.blocked_by : null;
      if (e.payload.to === 'superseded') o.superseded_by = e.payload.superseded_by;
      o.last_line = line;
      break;
    }
    case 'run.started':
      if (order()) { order().runs++; order().last_line = line; }
      break;
    case 'run.finished':
      if (order()) { order().last_outcome = e.payload.outcome; order().last_line = line; }
      break;
    case 'evidence.attached':
      if (order()) {
        order().evidence.push({ path: e.payload.path ?? null, level: e.payload.level ?? null });
        order().last_line = line;
      }
      break;
    case 'ask.opened':
      state.asks[e.subject] = {
        kind: e.payload.kind, status: 'open', opened: e.ts, reason: e.payload.reason ?? e.payload.title ?? null,
        options: Array.isArray(e.payload.options) ? e.payload.options : null, resolved: null, decision: null, comment: null,
      };
      break;
    case 'ask.resolved':
      if (state.asks[e.subject]) {
        Object.assign(state.asks[e.subject], {
          status: 'resolved', resolved: e.ts, decision: e.payload.decision ?? null, comment: e.payload.comment ?? null,
        });
      }
      break;
    default:
      break;
  }
  return state;
}

export function replay(events) {
  const state = emptyState();
  events.forEach((e, i) => applyEvent(state, e, i + 1));
  return state;
}
