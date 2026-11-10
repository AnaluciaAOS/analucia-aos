// Hosting at the start (AMD-0006): the four answers, the cost table and the own-server checklist.
// The table is data kept by the director (core/hosting-options.json); the tool shows it and never picks an option.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RuleError } from './state.mjs';

export const HOSTING_CHOICES = ['managed', 'own-server', 'already', 'later'];
export const STALE_DAYS = 90;
const OPTIONS_PATH = fileURLToPath(new URL('../core/hosting-options.json', import.meta.url));
const CHECKLIST_PATH = fileURLToPath(new URL('../docs/hosting/VPS-CHECKLIST.md', import.meta.url));

// "managed" | "own-server" | "later" | "already: <where>" -> { choice, where }.
export function parseHosting(raw) {
  const v = String(raw).trim();
  const m = /^already\s*(?::\s*(.*))?$/s.exec(v);
  if (m) {
    const where = (m[1] ?? '').trim();
    if (!where) throw new RuleError('E_ANSWER_VALUE', `hosting: ${JSON.stringify(raw)} needs the place, for example "already: <where it runs>"`);
    return { choice: 'already', where };
  }
  if (!HOSTING_CHOICES.includes(v)) throw new RuleError('E_ANSWER_VALUE', `hosting: ${JSON.stringify(raw)} is not a valid answer (allowed: managed, own-server, already: <where>, later)`);
  return { choice: v };
}

export function loadOptions(path = OPTIONS_PATH) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  return Array.isArray(data) ? data : data.options ?? [];
}

const DAY = 24 * 60 * 60 * 1000;
export const ageDays = (checkedOn, now) => Math.floor((Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`) - Date.parse(`${checkedOn}T00:00:00Z`)) / DAY);
const usd = (n) => `$${n}`;
const range = (r) => (r.max === null || r.max === undefined ? `${usd(r.min)}+` : `${usd(r.min)}–${usd(r.max)}`);

// Sorted by the low end of the range, then by name. Every row carries its date and source.
export function hostingTable(t, { now = new Date(), options = loadOptions() } = {}) {
  const rows = [...options].sort((a, b) => a.monthly_usd.min - b.monthly_usd.min || a.name.localeCompare(b.name));
  const out = [t('hosting.title'), `  ${t('hosting.columns')}`];
  for (const o of rows) {
    out.push(`  - ${o.name} | ${t(`hosting.kind.${o.kind}`)} | ${range(o.monthly_usd)} (${o.price_note}) | ${t(`hosting.by.${o.operated_by}`)} | ${t(`hosting.recovery.${o.kind}`)} | ${t(`hosting.keys.${o.kind}`)} | ${o.checked_on} | ${o.source}`);
    const days = ageDays(o.checked_on, now);
    if (days > STALE_DAYS) out.push(`    ! ${t('hosting.stale', { days })}`);
  }
  out.push(`  ${t('hosting.prices_change')}`);
  return out.join('\n');
}

// The items of docs/hosting/VPS-CHECKLIST.md ("- [ ] …" lines), shown when the owner picks own-server.
export function vpsChecklist(path = CHECKLIST_PATH) {
  return readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => /^- \[ \] /.test(l)).map((l) => l.slice(6).trim());
}

export function checklistText(t, items = vpsChecklist()) {
  return [t('hosting.checklist_title'), ...items.map((i) => `  [ ] ${i}`), `  ${t('hosting.checklist_note')}`].join('\n');
}
