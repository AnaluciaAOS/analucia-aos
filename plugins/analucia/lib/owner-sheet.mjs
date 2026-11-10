// Asks as records and the owner sheet (SPEC-0004 §1–§2): aos ask open, aos ceo export, aos ceo import.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CATALOG, LOCALES } from './catalog.mjs';
import { enums } from './enums.mjs';
import { hashLF, readLock } from './lock.mjs';
import { appendEvent, readLog } from './log.mjs';
import { RuleError, replay } from './state.mjs';
import { ASK_ID_RE, DEFAULT_DECIDE_OPTIONS, askBody, askOptions, parseFrontMatter, validateAskText } from './validate.mjs';
import { readWorkbook, writeWorkbook } from './xlsx.mjs';

const askPath = (root, id) => join(root, '.analucia', 'asks', `${id}.md`);
const orderPath = (root, id) => join(root, '.analucia', 'orders', `${id}.md`);

// ---------- aos ask open ----------

export function askOpen(root, id, { now = new Date() } = {}) {
  const rel = `.analucia/asks/${id}.md`;
  if (!ASK_ID_RE.test(id ?? '')) throw new RuleError('E_ID_FORMAT', `${JSON.stringify(id)} is not an ask ID (ASK-0000)`);
  if (!existsSync(askPath(root, id))) throw new RuleError('E_FILE_MISSING', `${rel} does not exist; the director writes it first`);
  const expected = readLock(root)?.files?.[rel];
  if (!expected) throw new RuleError('E_NOT_LOCKED', `${rel} is not listed in .analucia/director.lock; the director adds it (with its sha256) before opening the ask`);
  const bytes = readFileSync(askPath(root, id));
  if (hashLF(bytes) !== expected) throw new RuleError('E_DIRECTOR_FILE_CHANGED', `${rel} differs from its hash in .analucia/director.lock`);
  const text = bytes.toString('utf8');
  const problems = validateAskText(text, `${id}.md`);
  if (problems.length) throw new RuleError(problems[0].code, `${rel}:${problems[0].line}: ${problems[0].message}`);
  const s = replay(readLog(root).events);
  if (s.records[id] || s.asks[id]) throw new RuleError('E_RECORD_EXISTS', `${id} already exists in the event log`);
  const { fields } = parseFrontMatter(text);
  const payload = { kind: fields.get('kind').value, title: fields.get('title').value, options: askOptions(fields) };
  appendEvent(root, { type: 'record.created', actor: 'director', subject: id, payload: {} }, { now });
  appendEvent(root, { type: 'ask.opened', actor: 'director', subject: id, payload }, { now });
  return payload;
}

// ---------- data for the sheet ----------

function readFields(path) {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  return { fields: parseFrontMatter(text).fields, text };
}

// Who acts next, by state (SPEC-0004 §2 "Next action by").
export function nextActionBy(order) {
  switch (order.state) {
    case 'draft': case 'ready': return 'director';
    case 'queued': case 'active': case 'paused': return 'executor';
    case 'blocked': return /^ASK-\d{4}$/.test(order.blocked_by ?? '') ? 'owner' : 'director';
    case 'delivered': return 'system';
    case 'verified': return 'owner';
    default: return '—';
  }
}

const git = (root, args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// Commits per order (message or Analucia-Order trailer names it), and whether all of them are on origin/<branch>.
export function commitsByOrder(root) {
  const byOrder = new Map();
  const log = git(root, ['log', '--format=%H%x1f%h%x1f%B%x1e']);
  if (log.status !== 0) return { byOrder, onRemote: () => '—' };
  for (const rec of log.stdout.split('\x1e')) {
    const [full, short, body = ''] = rec.replace(/^\s+/, '').split('\x1f');
    if (!full) continue;
    for (const id of new Set(body.match(/\bORD-\d{4}(?:\.[A-Z])?\b/g) ?? [])) {
      if (!byOrder.has(id)) byOrder.set(id, []);
      byOrder.get(id).push({ full, short });
    }
  }
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  const remote = git(root, ['rev-list', `origin/${branch}`]);
  const pushed = remote.status === 0 ? new Set(remote.stdout.split('\n').filter(Boolean)) : null;
  const onRemote = (id) => {
    const list = byOrder.get(id) ?? [];
    if (!list.length) return '—';
    if (!pushed) return 'no';
    return list.every((c) => pushed.has(c.full)) ? 'yes' : 'no';
  };
  return { byOrder, onRemote };
}

export function sheetData(root) {
  const s = replay(readLog(root).events);
  const asks = Object.keys(s.asks).sort().map((id) => {
    const a = s.asks[id];
    const file = readFields(askPath(root, id));
    return {
      id, kind: a.kind, status: a.status, decision: a.decision ?? '', comment: a.comment ?? '',
      question: file ? askBody(file.text) : (a.reason ?? ''),
      recommendation: file?.fields.get('recommendation')?.value ?? '',
      options: a.options?.length ? a.options : (a.kind === 'decide' ? DEFAULT_DECIDE_OPTIONS : []),
    };
  });
  const { byOrder, onRemote } = commitsByOrder(root);
  const orders = Object.keys(s.orders).sort().map((id) => {
    const o = s.orders[id];
    const file = readFields(orderPath(root, id));
    return {
      id, title: file?.fields.get('title')?.value ?? '', risk: file?.fields.get('risk')?.value ?? '—', state: o.state,
      next: nextActionBy(o), commits: (byOrder.get(id) ?? []).map((c) => c.short).join(', ') || '—', onGitHub: onRemote(id),
    };
  });
  return { asks, orders };
}

// ---------- aos ceo export ----------

export const DEFAULT_SHEET = '.analucia/views/owner-sheet.xlsx';
export const SIGNOFF_OPTIONS = ['close', 'hold'];

export function buildSheets(data, locale = 'en') {
  const t = CATALOG[locale];
  const h = (texts) => texts.map((v) => ({ v, style: 'header' }));
  const askRows = [h(t.asks)];
  const askValidations = [];
  data.asks.forEach((a, i) => {
    const r = i + 2;
    const open = a.status === 'open';
    askRows.push([
      a.id, a.kind, { v: a.question, style: 'wrap' }, { v: a.recommendation, style: 'wrap' }, a.status,
      open ? { v: '', style: 'input' } : a.decision, open ? { v: '', style: 'input' } : { v: a.comment, style: 'wrap' },
    ]);
    if (open && a.options.length) askValidations.push({ ref: `F${r}`, list: a.options });
  });
  const orderRows = [h(t.orders)];
  const orderValidations = [];
  data.orders.forEach((o, i) => {
    const r = i + 2;
    const signable = o.state === 'verified';
    orderRows.push([
      o.id, { v: o.title, style: 'wrap' }, o.risk, o.state, o.next, { v: o.commits, style: 'wrap' }, o.onGitHub,
      signable ? { v: '', style: 'input' } : null, signable ? { v: '', style: 'input' } : null,
    ]);
    if (signable) orderValidations.push({ ref: `H${r}`, list: SIGNOFF_OPTIONS });
  });
  return [
    { name: t.sheets.howto, columns: [110], rows: t.howto.map((line) => [{ v: line, style: 'wrap' }]) },
    { name: t.sheets.asks, columns: [11, 10, 60, 40, 10, 16, 40], rows: askRows, freeze: true, autoFilter: true, protect: true, validations: askValidations },
    { name: t.sheets.orders, columns: [11, 44, 8, 11, 15, 22, 10, 13, 40], rows: orderRows, freeze: true, autoFilter: true, protect: true, validations: orderValidations },
    { name: t.sheets.states, columns: [12, 70], rows: [h(t.statesHeader), ...enums.order_states.map((st) => [st, { v: t.states[st], style: 'wrap' }])], freeze: true, autoFilter: true },
  ];
}

export function ceoExport(root, { out = DEFAULT_SHEET, locale = 'en', sharedStrings = false } = {}) {
  if (!LOCALES.includes(locale)) throw new RuleError('E_FIELD_TYPE', `--locale must be one of: ${LOCALES.join(', ')}`);
  const data = sheetData(root);
  const target = resolve(root, out); // an absolute --out is honoured; a relative one is relative to the repo root (OBS-R8-055)
  mkdirSync(dirname(target), { recursive: true });
  const buf = writeWorkbook(buildSheets(data, locale), { sharedStrings });
  writeFileSync(target, buf);
  return { path: out, bytes: buf.length, asks: data.asks.length, orders: data.orders.length };
}

// ---------- aos ceo import ----------

const findSheet = (wb, key, index) => {
  const names = LOCALES.map((l) => CATALOG[l].sheets[key]);
  return wb.sheets.find((s) => names.includes(s.name)) ?? wb.sheets[index];
};
const rowsOf = (sheet) => {
  const max = Math.max(1, ...[...sheet.cells.keys()].map((k) => Number(/\d+$/.exec(k)[0])));
  return Array.from({ length: max - 1 }, (_, i) => i + 2);
};
const cell = (sheet, at) => (sheet.cells.get(at) ?? '').trim();

// Reads the workbook and returns the plan, or throws E_SHEET_VALUE with every problem (nothing is recorded).
export function importPlan(root, path) {
  if (!existsSync(path)) throw new RuleError('E_FILE_MISSING', `${path} does not exist`);
  let wb;
  try {
    wb = readWorkbook(readFileSync(path));
  } catch (x) {
    throw new RuleError('E_SHEET_VALUE', `${path} is not a readable .xlsx workbook (${x.message})`);
  }
  const s = replay(readLog(root).events);
  const problems = [];
  const plan = [];
  const asks = findSheet(wb, 'asks', 1);
  const orders = findSheet(wb, 'orders', 2);
  if (!asks || !orders) throw new RuleError('E_SHEET_VALUE', 'the workbook has no Asks or Orders sheet; export a fresh one with "aos ceo export"');

  for (const r of rowsOf(asks)) {
    const id = cell(asks, `A${r}`);
    if (!id) continue;
    const at = `${asks.name}!F${r}`;
    const decision = cell(asks, `F${r}`).toLowerCase();
    const comment = cell(asks, `G${r}`);
    const ask = s.asks[id];
    if (!ask) { problems.push(`${asks.name}!A${r}: ${JSON.stringify(id)} is not an ask in the log`); continue; }
    if (ask.status !== 'open') {
      if (decision && decision !== (ask.decision ?? '').toLowerCase()) problems.push(`${at}: ${id} is already resolved (${ask.decision}); it cannot be decided again`);
      continue;
    }
    if (!decision) {
      if (comment) problems.push(`${at}: ${id} has a comment but no decision; pick a decision or clear the comment`);
      continue;
    }
    const options = ask.options?.length ? ask.options : (ask.kind === 'decide' ? DEFAULT_DECIDE_OPTIONS : []);
    if (!options.includes(decision)) { problems.push(`${at}: ${JSON.stringify(decision)} is not an option of ${id} (${options.join(', ')})`); continue; }
    plan.push({ kind: 'ask', id, decision, comment });
  }

  for (const r of rowsOf(orders)) {
    const id = cell(orders, `A${r}`);
    if (!id) continue;
    const at = `${orders.name}!H${r}`;
    const signoff = cell(orders, `H${r}`).toLowerCase();
    const comment = cell(orders, `I${r}`);
    const order = s.orders[id];
    if (!order) { problems.push(`${orders.name}!A${r}: ${JSON.stringify(id)} is not an order in the log`); continue; }
    if (!signoff || signoff === 'hold') continue;
    if (signoff !== 'close') { problems.push(`${at}: ${JSON.stringify(signoff)} is not a sign-off (${SIGNOFF_OPTIONS.join(', ')})`); continue; }
    if (order.state !== 'verified') { problems.push(`${at}: ${id} is "${order.state}"; only verified orders can be closed`); continue; }
    plan.push({ kind: 'close', id, comment });
  }

  if (problems.length) throw Object.assign(new RuleError('E_SHEET_VALUE', `${problems.length} value(s) in the sheet cannot be recorded; nothing was recorded`), { problems });
  return plan;
}

export const describePlan = (plan) => plan.map((p) => (p.kind === 'ask'
  ? `  ${p.id}: ask.resolved, decision "${p.decision}"${p.comment ? `, comment "${p.comment}"` : ''}`
  : `  ${p.id}: verified -> closed (owner)${p.comment ? `, comment "${p.comment}"` : ''}`));

// Owner TTY first (like close), then all-or-nothing validation, then CONFIRM, then the events.
export async function ceoImport(root, path, { isTTY, ask, now = new Date() }) {
  if (!isTTY) throw new RuleError('E_OWNER_TTY', 'importing the owner sheet needs the owner at an interactive terminal; stdin is not a TTY (agents cannot sign). The owner runs "aos ceo import <file>" in their own terminal');
  const plan = importPlan(root, path);
  if (!plan.length) return [];
  const answer = await ask(`The sheet will record:\n${describePlan(plan).join('\n')}\nType CONFIRM to record: `);
  if (answer.trim() !== 'CONFIRM') throw new RuleError('E_NOT_CONFIRMED', 'nothing recorded: the confirmation was not "CONFIRM"');
  for (const p of plan) {
    if (p.kind === 'ask') appendEvent(root, { type: 'ask.resolved', actor: 'owner', subject: p.id, payload: { decision: p.decision, comment: p.comment, via: 'sheet' } }, { now });
    else appendEvent(root, { type: 'order.state_changed', actor: 'owner', subject: p.id, payload: { from: 'verified', to: 'closed', via: 'sheet', ...(p.comment ? { comment: p.comment } : {}) } }, { now });
  }
  return plan;
}
