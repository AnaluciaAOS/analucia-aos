// The queue view (AMD-0005 §1): every order that is not signed, in the order it will be done — an order after the
// ones it depends on, then by id — with its state in the owner's words and the next actor.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOCALES, catalog } from './onboarding.mjs';
import { readLog } from './log.mjs';
import { nextActionBy } from './owner-sheet.mjs';
import { metricOf, waivedOrders } from './status.mjs';
import { parseFrontMatter } from './validate.mjs';

// Terminal without a signature (rejected, superseded, cancelled) leaves the queue too: nothing is left to do.
const DONE = new Set(['closed', 'rejected', 'superseded', 'cancelled']);
const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function orderFile(root, id) {
  const p = join(root, '.analucia', 'orders', `${id}.md`);
  if (!existsSync(p)) return { title: '', depends_on: [], continues: null };
  const { fields } = parseFrontMatter(readFileSync(p, 'utf8'));
  const deps = fields.get('depends_on')?.value;
  const continues = fields.get('continues')?.value;
  return { title: fields.get('title')?.value ?? '', depends_on: Array.isArray(deps) ? deps : [], continues: typeof continues === 'string' && continues ? continues : null };
}

// orders: the derived state's orders map. Returns [{ id, state, next, title, depends_on }] in queue order.
export function buildQueue(root, orders) {
  const open = Object.keys(orders).filter((id) => !DONE.has(orders[id].state)).sort(byId);
  const info = Object.fromEntries(open.map((id) => [id, orderFile(root, id)]));
  const openSet = new Set(open);
  // Kahn's algorithm over the open orders; a dependency that is already done (or unknown) is satisfied.
  const waiting = Object.fromEntries(open.map((id) => [id, new Set(info[id].depends_on.filter((d) => openSet.has(d)))]));
  const out = [];
  const placed = new Set();
  while (out.length < open.length) {
    const ready = open.filter((id) => !placed.has(id) && [...waiting[id]].every((d) => placed.has(d)));
    // A dependency cycle cannot be ordered: the rest goes by id, so the view never hides an order.
    const next = ready.length ? ready[0] : open.find((id) => !placed.has(id));
    placed.add(next);
    out.push(next);
  }
  // ORD-0042 part 6: the metric of each order that has a recorded decision (measured from the log).
  let events = [];
  try { events = readLog(root).events; } catch { /* no log: no metric */ }
  return out.map((id) => ({ metric: metricOf(events, id), id, state: orders[id].state, next: nextActionBy(orders[id]), title: info[id].title, depends_on: info[id].depends_on, continues: info[id].continues }));
}

export function queueText(queue, locale = 'en', waived = []) {
  const t = catalog(LOCALES.includes(locale) ? locale : 'en');
  const out = [`# ${t('queue.title')}`, '', t('queue.intro'), ''];
  if (!queue.length) out.push(t('queue.empty'));
  // ORD-0043 part 2: the orders that were closed with checks of form waived by the owner.
  const tail = waived.length ? ['', t('queue.waived_title'), ...waived.map((w) => `- ${w.id} — ${t('queue.waived', { n: w.n })}`)] : [];
  queue.forEach((q, i) => {
    out.push(`${i + 1}. ${q.id}${q.continues ? ` (${t('queue.continues')} ${q.continues})` : ''} — ${t(`queue.state.${q.state}`)} (${q.state}) — ${t('queue.next')}: ${q.next}${q.title ? ` — ${q.title}` : ''}${q.metric && q.metric.minutes !== null ? ` — ${t('queue.metric', { minutes: q.metric.minutes, steps: q.metric.owner_steps })}` : ''}`);
  });
  return `${[...out, ...tail].join('\n')}\n`;
}

export function writeQueueView(root, queue) {
  let locale = 'en';
  try { locale = JSON.parse(readFileSync(join(root, '.analucia', 'project.json'), 'utf8')).locale ?? 'en'; } catch { /* default */ }
  const dir = join(root, '.analucia', 'views');
  mkdirSync(dir, { recursive: true });
  let waived = [];
  try { waived = waivedOrders(readLog(root).events); } catch { /* no log: nothing was waived */ }
  const text = queueText(queue, locale, waived);
  writeFileSync(join(dir, 'queue.md'), text);
  return text;
}
