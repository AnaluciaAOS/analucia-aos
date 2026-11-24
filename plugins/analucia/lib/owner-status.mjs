// ORD-0046 part 2 (owner's adjustment 1): `aos status --owner` and the launcher ESTADO. In at most six plain lines:
// which order runs now, in which part and run it is, and whether it waits for something of the owner (and the button
// that does it). With nothing running it says what comes next. It reads the state and changes nothing.
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openRuns } from './guards.mjs';
import { readLog } from './log.mjs';
import { TOUCH_TARGET, activeMinutesOf, touchesOf } from './measures.mjs';
import { waitingFor } from './waiting.mjs';
import { replay } from './state.mjs';

// The button that answers each thing the owner can wait for.
export const OWNER_BUTTON = { sign: 'FIRMAR', review: 'FIRMAR', place: 'FIRMAR', answer: 'IMPORTAR' };

const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };

// The name the owner knows the project by: its code, else its folder.
export function projectName(root) {
  try {
    const code = JSON.parse(read(join(root, '.analucia', 'project.json'))).project_code;
    if (typeof code === 'string' && code) return code;
  } catch { /* no project file: the folder name */ }
  return basename(resolve(root));
}

const titleOf = (root, id) => {
  const m = /^title:\s*(.+)$/m.exec(read(join(root, '.analucia', 'orders', `${id}.md`)));
  const s = (m?.[1] ?? '').trim();
  return s.length > 60 ? `${s.slice(0, 57).trimEnd()}...` : s;
};

// { total, last } parts of an order: the headings "## Part N" of the order, and the highest part N that the report
// ("Part N: done") or a commit subject ("<ID> part N") already names. last = 0 when nothing names a part.
export function partsOf(root, id) {
  const total = (read(join(root, '.analucia', 'orders', `${id}.md`)).match(/^## Part \d+\b/gm) ?? []).length;
  let last = 0;
  for (const m of read(join(root, '.analucia', 'evidence', id, 'report.md')).matchAll(/^Part (\d+): done\b/gm)) last = Math.max(last, Number(m[1]));
  const g = spawnSync('git', ['-C', root, 'log', '--format=%s', `--grep=${id} part `], { encoding: 'utf8' });
  if (g.status === 0) for (const m of g.stdout.matchAll(new RegExp(`${id} part (\\d+)`, 'gi'))) last = Math.max(last, Number(m[1]));
  return { total, last };
}

// The lines of ESTADO as [{ key, vars }] in the catalog's keys; the caller adds the closing OK line.
export function ownerStatusLines(root, { now = new Date() } = {}) {
  const lines = [{ key: 'ostatus.title', vars: { project: projectName(root) } }];
  if (existsSync(join(root, '.analucia', 'HALT'))) {
    lines.push({ key: 'ostatus.halted', vars: {} });
    return lines;
  }
  const { events } = readLog(root);
  const orders = replay(events).orders;
  const open = openRuns(events);
  const w = waitingFor(root, events);
  if (open.length) {
    const { id, run } = open[0];
    const budget = events.filter((e) => e.subject === id && e.type === 'run.started').at(-1)?.payload?.budget ?? {};
    lines.push({ key: 'ostatus.running', vars: { id, title: titleOf(root, id), run: run ?? '?', of: budget.max_attempts ?? '?' } });
    const p = partsOf(root, id);
    if (p.total) lines.push({ key: p.last >= p.total ? 'ostatus.part_all' : 'ostatus.part', vars: { part: Math.min(p.last + 1, p.total), total: p.total } });
    else lines.push({ key: 'ostatus.part_unknown', vars: {} });
    // ORD-0046 part 6: how many times the owner has acted on this order since his decision (target 2).
    const touches = touchesOf(events, id);
    // ORD-0047 part 17: the active minutes ride on the same line, so ESTADO stays within its lines.
    if (touches !== null) lines.push({ key: 'ostatus.touches', vars: { n: touches, target: TOUCH_TARGET, minutes: activeMinutesOf(events, id) } });
  } else {
    lines.push({ key: 'ostatus.idle', vars: {} });
  }
  if (w.owner.length) {
    const first = w.owner[0];
    lines.push({ key: 'ostatus.waits_you', vars: { act: first.act, id: first.id, button: OWNER_BUTTON[first.act] ?? 'FIRMAR', more: w.owner.length > 1 ? w.owner.length - 1 : 0 } });
  } else {
    lines.push({ key: 'ostatus.waits_none', vars: {} });
  }
  if (!open.length) {
    const next = [...w.executor, ...w.director][0];
    const live = Object.values(orders).some((o) => !['closed', 'rejected', 'superseded', 'cancelled'].includes(o.state));
    if (next) lines.push({ key: 'ostatus.next', vars: { act: next.act, id: next.id } });
    else if (!live || !w.owner.length) lines.push({ key: 'ostatus.next_none', vars: {} });
  }
  return lines;
}

// The text, in the owner's catalog `t`. The act of a line is spelled with the words of status.wait.<act>.
export function ownerStatusText(root, t) {
  return ownerStatusLines(root).map(({ key, vars }) => {
    const v = { ...vars };
    if (v.act) v.act = t(`status.wait.${v.act}`);
    if (key === 'ostatus.waits_you') v.more = v.more ? t('ostatus.more', { n: v.more }) : '';
    return t(key, v);
  });
}
