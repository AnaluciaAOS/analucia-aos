// Sessions inside an order (AMD-0007 §2, ORD-0023 part B). A session is the work of one agent window.
// The SessionStart hook appends session.start, the SessionEnd hook appends session.end (both actor system), with the
// Claude Code session_id, the order whose run is open at that moment (or null) and the provider name the plugin
// already records in `agent.tool`. The order lifecycle is not touched: sessions are only read back by derive.
import { appendEvent, readLog } from './log.mjs';

export const PROVIDER = 'claude-code';

// Order -> run number, for every run.started without a later run.finished.
const openRuns = (events) => {
  const open = new Map();
  for (const e of events) {
    if (!e.subject) continue;
    if (e.type === 'run.started') open.set(e.subject, e.payload?.run ?? null);
    if (e.type === 'run.finished') open.delete(e.subject);
  }
  return open;
};

// The order whose run is open now, or null.
export const openRunOrder = (events) => [...openRuns(events).keys()].at(-1) ?? null;

function append(root, type, input, extra, now) {
  const session = typeof input.session_id === 'string' && input.session_id ? input.session_id : null;
  if (!session) return null; // not called by Claude Code: nothing to record
  const order = openRunOrder(readLog(root).events);
  const agent = { tool: PROVIDER, session };
  if (typeof input.model === 'string') agent.model = input.model;
  return appendEvent(root, { type, actor: 'system', subject: order, agent, payload: { session, order, provider: PROVIDER, ...extra } }, { now });
}

export const sessionStarted = (root, input = {}, { now = new Date() } = {}) => append(root, 'session.start', input, { source: typeof input.source === 'string' ? input.source : 'startup' }, now);
export const sessionEnded = (root, input = {}, { now = new Date() } = {}) => append(root, 'session.end', input, { reason: typeof input.reason === 'string' ? input.reason : 'other' }, now);

export const resumeCommand = (session) => `claude --resume ${session}`;

// One entry per session id, from its last start. A start with no end after it (and no later start of the same
// session, which is a resume) is interrupted. A session that ended while its order's run is still open is shown too.
export function sessionsView(events) {
  const byId = new Map();
  for (const e of events) {
    if (e.type !== 'session.start' && e.type !== 'session.end') continue;
    const p = e.payload ?? {};
    const s = byId.get(p.session) ?? { session: p.session, provider: p.provider, order: null, started: null, source: null, ended: null, reason: null, starts: 0 };
    if (e.type === 'session.start') {
      Object.assign(s, { started: e.ts, source: p.source ?? null, order: p.order ?? s.order, ended: null, reason: null });
      s.starts += 1;
    } else {
      Object.assign(s, { ended: e.ts, reason: p.reason ?? null, order: s.order ?? p.order ?? null });
    }
    byId.set(p.session, s);
  }
  const open = openRuns(events);
  return [...byId.values()].filter((s) => s.started).map((s) => {
    const status = s.ended ? 'ended' : 'interrupted';
    return { ...s, status, run_open: Boolean(s.order && open.has(s.order)), resume: resumeCommand(s.session) };
  }).sort((a, b) => Date.parse(a.started) - Date.parse(b.started) || (a.session < b.session ? -1 : 1));
}

// The resume.md lines: sessions per order, then what needs attention.
export function sessionLines(sessions) {
  if (!sessions.length) return [];
  const out = ['', `## Sessions (${sessions.length})`, ''];
  const perOrder = new Map();
  for (const s of sessions) {
    const k = s.order ?? 'no order';
    const v = perOrder.get(k) ?? { n: 0, interrupted: 0 };
    v.n += 1;
    if (s.status === 'interrupted') v.interrupted += 1;
    perOrder.set(k, v);
  }
  for (const [k, v] of [...perOrder.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) out.push(`- ${k}: ${v.n} session(s)${v.interrupted ? `, ${v.interrupted} interrupted` : ''}`);
  for (const s of sessions.filter((x) => x.status === 'interrupted')) {
    out.push(`- interrupted: session ${s.session} (${s.order ?? 'no order'}) started ${s.started}, never ended. Resume it: ${s.resume}`);
  }
  for (const s of sessions.filter((x) => x.status === 'ended' && x.run_open)) {
    out.push(`- run still open: session ${s.session} ended ${s.ended} (${s.reason}) while the run of ${s.order} was open. Resume it: ${s.resume}, or record the outcome with aos run finish ${s.order}`);
  }
  return out;
}
