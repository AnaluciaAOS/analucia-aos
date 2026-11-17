// One "next step" (ORD-0040 part 3): `aos next` reads the state of the project and prints exactly one line: the
// single thing that comes next and who does it, in the project's language, with the click or the command that does
// it as it can be used on this machine. It writes nothing. It reuses what already decides "who is next":
// nextActionBy (owner sheet), the queue order (lib/queue.mjs), the open runs (guards), the documents under review
// (lib/review.mjs) and the drafts (lib/drafts.mjs).
// Precedence: halt › broken log › project not initialised › drafts or orders waiting for the owner › an open run ›
// a blocked order › a queued order › nothing pending.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { aosCommand } from './cli.mjs';
import { DIRECTOR_ENTRY_REL, listDrafts } from './drafts.mjs';
import { findRoot, openRuns } from './guards.mjs';
import { launcherAt } from './launchers.mjs';
import { personLocale } from './locale.mjs';
import { logPath, readLog, verifyChain } from './log.mjs';
import { catalog } from './onboarding.mjs';
import { nextActionBy } from './owner-sheet.mjs';
import { buildQueue } from './queue.mjs';
import { reviewState } from './review.mjs';
import { replay } from './state.mjs';

const posix = (p) => resolve(p).split(sep).join('/');
const list = (ids, max = 3) => (ids.length > max ? `${ids.slice(0, max).join(', ')} +${ids.length - max}` : ids.join(', '));

// start: the folder to look from. explicit: `start` is the project root itself (--root), not a place to search from.
// Returns { who, key, vars, root } — the catalog key of the line and what it needs.
export function nextStep(start, { explicit = false } = {}) {
  const here = resolve(start);
  const root = explicit ? (existsSync(join(here, '.analucia')) ? here : null) : findRoot(here);
  const dir = posix(root ?? here);
  const cmd = (args) => `${aosCommand()} ${args}`;
  // The click when its launcher is installed in the project root, else the command to type.
  const how = (name, args) => {
    const file = launcherAt(root ?? here, name);
    return file ? { key: 'next.click', vars: { file, dir } } : { key: 'next.type', vars: { cmd: cmd(args) } };
  };

  if (root && existsSync(join(root, '.analucia', 'HALT'))) {
    let reason = '';
    try { reason = JSON.parse(readFileSync(join(root, '.analucia', 'HALT'), 'utf8')).reason ?? ''; } catch { /* shown without a reason */ }
    return { who: 'owner', key: 'next.halt', vars: { reason }, how: how('REANUDAR', 'resume'), root };
  }
  if (root && existsSync(logPath(root))) {
    const broken = verifyChain(readFileSync(logPath(root)));
    if (broken) return { who: 'director', key: 'next.broken_log', vars: { line: broken.line, code: broken.code, cmd: cmd('verify-log') }, root };
  }
  if (!root || !existsSync(logPath(root))) {
    if (launcherAt(root ?? here, 'INICIAR')) return { who: 'owner', key: 'next.init', vars: { dir }, how: how('INICIAR', 'init'), root };
    return { who: 'anyone', key: 'next.install_launchers', vars: { dir, cmd: cmd('launchers install') }, root };
  }

  const { events } = readLog(root);
  const state = replay(events);
  const orders = state.orders;
  const ids = (s) => Object.keys(orders).filter((id) => orders[id].state === s).sort();

  // Waiting for the owner: drafts to place, finished orders to sign, documents to review — all in `aos sign`.
  const drafts = listDrafts(root);
  const ready = drafts.filter((d) => d.ok).map((d) => d.id);
  const toSign = [...ids('delivered'), ...ids('verified')].sort();
  const reviews = reviewState(root, events).filter((d) => d.status === 'waiting');
  if (ready.length || toSign.length || reviews.length) {
    const what = [];
    if (ready.length) what.push({ key: 'next.what_drafts', vars: { n: ready.length, ids: list(ready) } });
    if (toSign.length) what.push({ key: 'next.what_orders', vars: { n: toSign.length, ids: list(toSign) } });
    if (reviews.length) what.push({ key: 'next.what_reviews', vars: { n: reviews.length } });
    return { who: 'owner', key: 'next.sign', vars: {}, what, how: how('FIRMAR', 'sign'), root };
  }
  const asks = Object.keys(state.asks).filter((id) => state.asks[id].status === 'open').sort();
  if (asks.length) {
    const file = launcherAt(root, 'IMPORTAR');
    const drop = file ? { key: 'next.click_drop', vars: { file, dir } } : { key: 'next.type_import', vars: { cmd: cmd('ceo import') } };
    return { who: 'owner', key: 'next.asks', vars: { n: asks.length, ids: list(asks), export: cmd('ceo export') }, how: drop, root };
  }

  const open = openRuns(events);
  if (open.length) {
    const { id, run } = open[0];
    return { who: 'executor', key: 'next.open_run', vars: { id, run: run ?? '?', cmd: cmd(`run finish ${id} --outcome <outcome> --evidence .analucia/evidence/${id}/report.md`) }, root };
  }
  const blocked = ids('blocked');
  if (blocked.length) {
    const id = blocked[0];
    const who = nextActionBy(orders[id]);
    return { who, key: 'next.blocked', vars: { who, id, by: orders[id].blocked_by ?? orders[id].reason ?? '' }, root };
  }
  const notReady = drafts.filter((d) => !d.ok).map((d) => d.id);
  if (notReady.length) return { who: 'director', key: 'next.fix_drafts', vars: { n: notReady.length, ids: list(notReady), cmd: cmd('drafts') }, root };
  const queue = buildQueue(root, orders);
  const paused = queue.find((q) => q.state === 'paused');
  const queued = queue.find((q) => q.state === 'queued');
  if (queued) return { who: 'executor', key: 'next.queued', vars: { id: queued.id, continues: queued.continues, title: queued.title, cmd: cmd(`run start ${queued.id}`) }, root };
  if (paused) return { who: 'executor', key: 'next.paused', vars: { id: paused.id, cmd: cmd(`resume-order ${paused.id}`) }, root };
  return { who: 'owner', key: 'next.nothing', vars: { entry: DIRECTOR_ENTRY_REL }, root };
}

// The one line, in the project's language (the same fallback as every other line printed for a person).
export function nextLine(start, { explicit = false, locale } = {}) {
  let step;
  try {
    step = nextStep(start, { explicit });
  } catch (x) {
    // A log that cannot even be read is a broken log.
    step = { who: 'director', key: 'next.broken_log', vars: { line: '?', code: x.code ?? 'E_JSON', cmd: `${aosCommand()} verify-log` }, root: null };
  }
  const t = catalog(locale ?? personLocale(step.root));
  const vars = { ...step.vars };
  if (step.how) vars.how = t(step.how.key, step.how.vars);
  if (vars.continues) vars.id = `${vars.id} (${t('queue.continues')} ${vars.continues})`; // the earlier record it continues (AMD-0015 §2)
  if (step.what) vars.what = step.what.map((w) => t(w.key, w.vars)).join('; ');
  return t(step.key, vars).replace(/\s*\r?\n\s*/g, ' ').trim();
}
