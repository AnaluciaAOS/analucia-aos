// Generated views (never edited, never committed): .analucia/views/state.json and resume.md.
// Deterministic: the output depends only on the bytes of the event log, project.json, onboarding.json and, for the
// documents under review (AMD-0007 §1), the bytes of those documents.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { costSummary, monthOf, readProject, resumeLine } from './cost.mjs';
import { readLog, readWipLimit } from './log.mjs';
import { writeFirstHourView } from './metrics.mjs';
import { buildQueue, writeQueueView } from './queue.mjs';
import { reviewState } from './review.mjs';
import { sessionLines, sessionsView } from './sessions.mjs';
import { replay } from './state.mjs';
import { sha256Hex } from './validate.mjs';

const MAX_PENDING = 3;
const MAX_BLOCKED = 10;
const LAST_EVENTS = 10;

const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sortedObject = (o) => Object.fromEntries(Object.keys(o).sort(byId).map((k) => [k, o[k]]));
const instant = (ts) => Date.parse(ts);

export function summarize(e) {
  const p = e.payload ?? {};
  switch (e.type) {
    case 'order.state_changed': {
      const extra = p.blocked_by ? ` (blocked by ${p.blocked_by})` : p.reason ? ` (${p.reason})` : '';
      return `${p.from} -> ${p.to}${extra}`;
    }
    case 'run.finished': return `outcome ${p.outcome}`;
    case 'evidence.attached': return [p.level, p.path].filter(Boolean).join(' ');
    case 'record.amended': return p.amendment ? `by ${p.amendment}` : '';
    case 'order.admitted': return p.decision ?? '';
    case 'ask.opened': return [p.kind, p.reason].filter(Boolean).join(': ');
    case 'role.declared': return p.role ?? '';
    case 'review.requested': return p.path ?? '';
    case 'review.decision': return [p.decision, p.path].filter(Boolean).join(' ');
    case 'session.start': return [p.session, p.source].filter(Boolean).join(' ');
    case 'session.end': return [p.session, p.reason].filter(Boolean).join(' ');
    default: return '';
  }
}

export function buildViews(root) {
  const { raw, events } = readLog(root);
  const s = replay(events);
  const wipLimit = readWipLimit(root);
  const last = events.at(-1);

  const orders = sortedObject(s.orders);
  const counts = {};
  for (const o of Object.values(orders)) counts[o.state] = (counts[o.state] ?? 0) + 1;

  const pending = [
    ...Object.entries(s.asks).filter(([, a]) => a.status === 'open')
      .map(([id, a]) => ({ id, ts: a.opened, text: `${id} ask (${a.kind})${a.reason ? `: ${a.reason}` : ''}` })),
    ...Object.entries(orders).filter(([, o]) => o.state === 'verified')
      .map(([id, o]) => ({ id, ts: o.since, text: `${id} verified, awaiting owner signature` })),
  ].sort((a, b) => instant(a.ts) - instant(b.ts) || byId(a.id, b.id));

  const active = Object.entries(orders).filter(([, o]) => o.state === 'active');
  const blocked = Object.entries(orders).filter(([, o]) => o.state === 'blocked')
    .sort(([a, x], [b, y]) => instant(x.since) - instant(y.since) || byId(a, b));

  const state = {
    generated_from: {
      log: '.analucia/events.jsonl',
      lines: raw.length,
      last_event_id: last?.id ?? null,
      last_line_sha256: raw.length ? sha256Hex(raw.at(-1)) : null,
    },
    wip_limit: wipLimit,
    counts: sortedObject(counts),
    orders,
    asks: sortedObject(s.asks),
    pending_signatures: pending.map(({ id, ts }) => ({ id, since: ts })),
    // AMD-0005 §1: every order not signed yet, in the order it will be done.
    queue: buildQueue(root, orders).map(({ id, state, next, depends_on }) => ({ id, state, next, depends_on })),
  };
  // AMD-0007: documents under review and agent sessions, only when the log has any (older views stay identical).
  const reviews = reviewState(root, events);
  if (reviews.length) state.reviews = reviews.map(({ path, order, status, sha256, decision, correction }) => ({ path, order, status, sha256, decision, correction }));
  const sessions = sessionsView(events);
  if (sessions.length) state.sessions = sessions;

  const out = [];
  const countText = Object.entries(state.counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
  out.push(`Status: ${Object.keys(orders).length} orders (${countText}) · active ${active.length}/${wipLimit} · pending signatures ${pending.length} · ${raw.length} events · last ${last?.ts ?? 'never'}`);
  // SPEC-0003 §6: one budget line, only when a budget is set. Month = month of the last event (keeps derive deterministic).
  const project = readProject(root);
  if (last && typeof project.budget_monthly_usd === 'number') {
    const cost = costSummary(events, project, monthOf(last.ts));
    state.cost = cost;
    out.push(resumeLine(cost));
  }
  // SPEC-0005 §3: purpose and domain from the onboarding answers.
  const onb = join(root, '.analucia', 'onboarding.json');
  if (existsSync(onb)) {
    try {
      const a = JSON.parse(readFileSync(onb, 'utf8')).answers ?? {};
      if (a.purpose?.value) out.push(`Project: ${a.purpose.value}${a.domain?.value ? ` · ${a.domain.value}` : ''}`);
    } catch { /* an unreadable onboarding file is reported by aos init --check, not here */ }
  }
  out.push('', `## Pending signatures (${pending.length})`, '');
  if (!pending.length) out.push('- none');
  for (const p of pending.slice(0, MAX_PENDING)) out.push(`- ${p.ts} ${p.text}`);
  if (pending.length > MAX_PENDING) out.push(`- … and ${pending.length - MAX_PENDING} more`);
  out.push('', '## Active order', '');
  if (!active.length) out.push('- none');
  for (const [id, o] of active.slice(0, MAX_PENDING)) out.push(`- ${id} since ${o.since} (runs ${o.runs}${o.last_outcome ? `, last outcome ${o.last_outcome}` : ''})`);
  if (active.length > MAX_PENDING) out.push(`- … and ${active.length - MAX_PENDING} more`);
  out.push('', `## Blocked (${blocked.length})`, '');
  if (!blocked.length) out.push('- none');
  for (const [id, o] of blocked.slice(0, MAX_BLOCKED)) out.push(`- ${id} blocked by ${o.blocked_by}: ${o.reason ?? ''}`.trimEnd());
  if (blocked.length > MAX_BLOCKED) out.push(`- … and ${blocked.length - MAX_BLOCKED} more`);
  // AMD-0007 §1: the owner's notes reach the agent here, until the document is revised and requested again.
  const fixes = reviews.filter((d) => d.correction);
  if (fixes.length) {
    out.push('', `## Corrections to apply (${fixes.length})`, '');
    for (const d of fixes) out.push(`- ${d.path} (${d.order}) ${d.correction.decision} by the owner ${d.correction.ts}: ${d.correction.note}. Revise it, then: aos review request ${d.path} --order ${d.order}`);
  }
  const waiting = reviews.filter((d) => d.status === 'waiting');
  if (waiting.length) {
    out.push('', `## Documents waiting for the owner's review (${waiting.length})`, '');
    for (const d of waiting) out.push(`- ${d.path} (${d.order}): the owner decides in aos sign`);
  }
  out.push(...sessionLines(sessions));
  out.push('', `## Last ${Math.min(LAST_EVENTS, events.length)} events`, '');
  if (!events.length) out.push('- none');
  const start = Math.max(0, events.length - LAST_EVENTS);
  events.slice(start).forEach((e, i) => {
    const summary = summarize(e);
    out.push(`- ${start + i + 1}. ${e.ts} ${e.type} ${e.actor} ${e.subject ?? '-'}${summary ? ` ${summary}` : ''}`);
  });

  return { state: `${JSON.stringify(state, null, 2)}\n`, resume: `${out.join('\n')}\n` };
}

export function derive(root) {
  const views = buildViews(root);
  const dir = join(root, '.analucia', 'views');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), views.state);
  writeFileSync(join(dir, 'resume.md'), views.resume);
  writeFirstHourView(root); // AMD-0004
  writeQueueView(root, buildQueue(root, JSON.parse(views.state).orders)); // AMD-0005
  return views;
}
