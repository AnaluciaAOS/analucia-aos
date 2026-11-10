// The owner's first hour (AMD-0004): from the log only, how long it took from the start of onboarding to the first
// order the owner closed with evidence. Numbers only: no target and no verdict.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readLog } from './log.mjs';

// events: the parsed log, in log order.
export function firstHour(events) {
  const startIndex = events.findIndex((e) => e.type === 'onboarding.started');
  const startedAt = startIndex >= 0 ? startIndex : 0;
  const start = events[startedAt] ?? null;
  // The first close that counts: to `closed`, by the owner, on an order with at least one evidence.attached
  // before that close, after the start (AMD-0004 §3, §5). A director close, or one without evidence, never counts.
  const evidenceSeen = new Set();
  let close = null;
  let closeIndex = -1;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type === 'evidence.attached' && e.subject) evidenceSeen.add(e.subject);
    if (i < startedAt) continue;
    if (e.type === 'order.state_changed' && e.payload?.to === 'closed' && e.actor === 'owner' && evidenceSeen.has(e.subject)) {
      close = e;
      closeIndex = i;
      break;
    }
  }
  const window = close ? events.slice(startedAt, closeIndex + 1) : [];
  // ORD-0033 B.2: onboarding.started is appended after CONFIRM and carries when the interview began (started_at).
  const startTs = startIndex >= 0 && typeof start?.payload?.started_at === 'string' ? start.payload.started_at : start?.ts;
  return {
    started: start ? { ts: startTs, source: startIndex >= 0 ? 'onboarding.started' : 'first_event', line: startedAt + 1 } : null,
    first_closed: close ? { ts: close.ts, order: close.subject, line: closeIndex + 1 } : null,
    elapsed: close && start ? {
      minutes: Math.round((Date.parse(close.ts) - Date.parse(startTs)) / 60000),
      orders: new Set(window.filter((e) => e.type === 'record.created' && /^ORD-/.test(e.subject ?? '')).map((e) => e.subject)).size,
      runs: window.filter((e) => e.type === 'run.started').length,
    } : null,
    status: close ? 'reached' : 'not_reached',
  };
}

export function firstHourText(m) {
  return [
    `started: ${m.started ? `${m.started.ts} (${m.started.source}, line ${m.started.line})` : '—'}`,
    `first_closed: ${m.first_closed ? `${m.first_closed.ts} ${m.first_closed.order} (line ${m.first_closed.line})` : '—'}`,
    `elapsed: ${m.elapsed ? `${m.elapsed.minutes} min · ${m.elapsed.orders} orders · ${m.elapsed.runs} runs` : '—'}`,
    `status: ${m.status}`,
  ].join('\n');
}

// The derived view .analucia/views/first-hour.md (deterministic: from the log only).
export function firstHourView(events) {
  const m = firstHour(events);
  return `# First hour (AMD-0004)\n\nFrom the event log only. Numbers, no target.\n\n${firstHourText(m).split('\n').map((l) => `- ${l}`).join('\n')}\n`;
}

export function writeFirstHourView(root, events = readLog(root).events) {
  const dir = join(root, '.analucia', 'views');
  mkdirSync(dir, { recursive: true });
  const text = firstHourView(events);
  writeFileSync(join(dir, 'first-hour.md'), text);
  return text;
}
