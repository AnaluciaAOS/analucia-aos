// ORD-0043 part 6 (OBS-165): who waits for whom. One line for `aos status`: how many things wait for the owner, for
// the director and for the executor, each with its order ID and the single action. Read from the log and the
// drafts; it writes nothing. It uses what already decides "who is next" (nextActionBy, the queue order, the open
// runs, the documents under review, the drafts).
import { listDrafts } from './drafts.mjs';
import { openRuns } from './guards.mjs';
import { blockEnded, lastPreflight } from './lifecycle.mjs';
import { nextActionBy } from './owner-sheet.mjs';
import { buildQueue } from './queue.mjs';
import { reviewState } from './review.mjs';
import { replay } from './state.mjs';

// { owner: [{ act, id }], director: [...], executor: [...] } — act is one of: sign, review, place, answer, decide,
// fix, preflight, finish, rework, resume, start.
export function waitingFor(root, events) {
  const state = replay(events);
  const { orders } = state;
  const ids = (s) => Object.keys(orders).filter((id) => orders[id].state === s).sort();
  const owner = [];
  const director = [];
  const executor = [];
  for (const id of [...ids('delivered'), ...ids('verified')].sort()) owner.push({ act: 'sign', id });
  for (const id of [...new Set(reviewState(root, events).filter((d) => d.status === 'waiting').map((d) => d.order))].sort()) owner.push({ act: 'review', id });
  let drafts = [];
  try { drafts = listDrafts(root); } catch { /* no drafts folder that can be read: nothing to place */ }
  for (const d of drafts) (d.ok ? owner : director).push({ act: d.ok ? 'place' : 'fix', id: d.id });
  for (const id of Object.keys(state.asks).filter((a) => state.asks[a].status === 'open').sort()) owner.push({ act: 'answer', id });

  const open = openRuns(events);
  for (const { id } of open) executor.push({ act: 'finish', id });
  const back = ids('active').filter((id) => !open.some((r) => r.id === id));
  for (const id of back) executor.push({ act: 'rework', id });
  for (const id of ids('blocked')) {
    if (blockEnded(events, id)) executor.push({ act: 'resume', id });
    else if (nextActionBy(orders[id]) === 'director') director.push({ act: 'decide', id });
  }
  // One order at a time: a queued or paused order waits for the executor only when nothing is in work.
  if (!open.length && !back.length) {
    const queue = buildQueue(root, orders);
    const queued = queue.find((q) => q.state === 'queued');
    const paused = queue.find((q) => q.state === 'paused');
    if (queued && lastPreflight(root, queued.id)?.result === 'failed') director.push({ act: 'preflight', id: queued.id });
    else if (queued) executor.push({ act: 'start', id: queued.id });
    else if (paused) executor.push({ act: 'resume', id: paused.id });
  }
  return { owner, director, executor };
}

// The line, in the words of the catalog `t`.
export function waitingLine(root, events, t) {
  const w = waitingFor(root, events);
  const part = (who) => `${who} ${w[who].length}${w[who].length ? `: ${w[who].map((x) => `${t(`status.wait.${x.act}`)} ${x.id}`).join(', ')}` : ''}`;
  return `${t('status.waits')} — ${['owner', 'director', 'executor'].map(part).join(' · ')}`;
}
