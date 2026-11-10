// Cost governance (SPEC-0003 §6): cost records, threshold alerts, monthly status.
// Alerts inform the owner. They never stop work and never cut anything.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { enums } from './enums.mjs';
import { appendEvent, isoWithOffset, projectTimeZone, readLog } from './log.mjs';
import { RuleError, replay } from './state.mjs';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const monthOf = (ts) => ts.slice(0, 7); // ts carries the project's local time and offset
// The current month in the project time zone.
export const currentMonth = (now = new Date(), root) => isoWithOffset(now, root ? projectTimeZone(root) : undefined).slice(0, 7);
const cents = (n) => Math.round(n * 100) / 100;
export const money = (n) => `$${cents(n).toFixed(2)}`;

export function readProject(root) {
  const p = join(root, '.analucia', 'project.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
}

const isCost = (e, op) => e.type === 'operation.logged' && e.payload?.operation === op;

// Everything about one month, derived from the log.
export function costSummary(events, project, month) {
  const records = events.filter((e) => isCost(e, 'cost') && e.payload.month === month);
  const spent = cents(records.reduce((s, e) => s + e.payload.usd, 0));
  const budget = typeof project.budget_monthly_usd === 'number' ? project.budget_monthly_usd : null;
  let percent = null;
  if (budget !== null) percent = budget > 0 ? (spent / budget) * 100 : (spent > 0 ? Infinity : 0);
  const alerts = [...new Set(events.filter((e) => isCost(e, 'cost_alert') && e.payload.month === month).map((e) => e.payload.threshold))].sort((a, b) => a - b);
  // Closed in this month and still closed (closed is terminal; "not reopened" = current state is closed).
  const current = replay(events).orders;
  const closed = [...new Set(events
    .filter((e) => e.type === 'order.state_changed' && e.payload?.to === 'closed' && monthOf(e.ts) === month)
    .map((e) => e.subject))].filter((id) => current[id]?.state === 'closed').sort();
  return {
    month, currency: project.budget_currency ?? 'USD', budget, spent, records: records.length, percent, alerts, closed,
    cost_per_closed_order: closed.length ? cents(spent / closed.length) : null,
  };
}

export function costRecord(root, { usd, source, order, month, actor = 'director', now = new Date() }) {
  const amount = Number(usd);
  if (usd === undefined || !Number.isFinite(amount) || amount < 0) throw new RuleError('E_FIELD_TYPE', `--usd must be a number >= 0 (got ${JSON.stringify(usd ?? null)})`);
  if (!source || !String(source).trim()) throw new RuleError('E_MISSING_FIELD', '--source "<text>" is required (where the cost comes from: provider, invoice, meter)');
  const m = month ?? currentMonth(now, root);
  if (!MONTH_RE.test(m)) throw new RuleError('E_FIELD_TYPE', `--month must be YYYY-MM (got ${JSON.stringify(m)})`);
  const { events } = readLog(root);
  if (order !== undefined && !replay(events).orders[order]) throw new RuleError('E_NO_ORDER', `--order ${order} has no record in the event log`);
  appendEvent(root, { type: 'operation.logged', actor, subject: order ?? null, payload: { operation: 'cost', usd: amount, source: String(source), month: m } }, { now });

  const project = readProject(root);
  const summary = costSummary(readLog(root).events, project, m);
  const fired = [];
  if (summary.budget !== null) {
    for (const t of enums.cost_alert_thresholds) {
      if (summary.percent >= t && !summary.alerts.includes(t)) {
        appendEvent(root, {
          type: 'operation.logged', actor: 'system', subject: null,
          payload: { operation: 'cost_alert', threshold: t, month: m, spent_usd: summary.spent, budget_usd: summary.budget },
        }, { now });
        fired.push(t);
      }
    }
  }
  return { usd: amount, month: m, fired, summary: { ...summary, alerts: [...summary.alerts, ...fired] } };
}

export const ALERT_NEXT = '  next (owner): Review the month with "aos cost status" and decide whether to change the budget or the plan; nothing was stopped or cut.';

export function alertLine(t, s) {
  return `cost alert: ${s.month} spend crossed ${t}% of the monthly budget (${money(s.spent)} of ${money(s.budget)} ${s.currency})`;
}

const pct = (p) => (p === Infinity ? '∞' : `${Math.round(p)}`);

export function statusLines(s) {
  const lines = [];
  if (s.budget === null) lines.push(`Budget ${s.month}: not set (no budget_monthly_usd in .analucia/project.json); no alerts apply`);
  else lines.push(`Budget ${s.month}: ${money(s.budget)} ${s.currency}`);
  lines.push(`Spend ${s.month}: ${money(s.spent)} ${s.currency} in ${s.records} record(s)${s.budget !== null ? ` · ${pct(s.percent)}% of budget` : ''}`);
  lines.push(`Alerts crossed: ${s.alerts.length ? s.alerts.map((t) => `${t}%`).join(', ') : 'none'}`);
  lines.push(`Closed orders ${s.month}: ${s.closed.length}${s.closed.length ? ` (${s.closed.join(', ')})` : ''} · cost per closed order ${s.cost_per_closed_order === null ? 'n/a' : money(s.cost_per_closed_order)}`);
  return lines;
}

// The resume.md line (only when a budget is set).
export function resumeLine(s) {
  if (s.budget === null) return null;
  return `Budget ${s.month}: ${money(s.spent)} of ${money(s.budget)} (${pct(s.percent)}%) · cost per closed order ${s.cost_per_closed_order === null ? 'n/a' : money(s.cost_per_closed_order)}`;
}
