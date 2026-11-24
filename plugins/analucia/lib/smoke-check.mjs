// ORD-0047 part 2 (OBS-204): a smoke test of every new screen. An order that adds or changes screens lists them in its key
// `screens:` ("<published address>|<button>|<button>", or the address alone when it adds no button). `aos smoke check <ID>`
// reads the evidence folder: for every screen and button, a screenshot taken on the published site after pressing it, and
// one line per button in smoke.md: `- <address> | <button> | <what happened> | <screenshot file>`.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontMatter } from './validate.mjs';

export const OPEN = '(open)'; // the button of a screen that adds none: opening it is the action
const ERROR_WORDS = /\b(error|errors|failed|fails|failure|exception|typeerror|crash|crashed|500|404|undefined|blank|empty page)\b|se cay[óo]|fall[óo]|erro\b|错误|失败|त्रुटि|विफल/i;

export function orderText(root, id) {
  for (const rel of [`.analucia/orders/${id}.md`, `.analucia/drafts/${id}.md`]) {
    if (existsSync(join(root, rel))) return readFileSync(join(root, rel), 'utf8');
  }
  return null;
}

// [{ address, button }] of the key `screens:`; [] when the order has none.
export function screensOf(text) {
  let list;
  try { list = parseFrontMatter(text).fields.get('screens')?.value; } catch { return []; }
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) => {
    const [address, ...buttons] = item.split('|').map((s) => s.trim()).filter(Boolean);
    if (!address) return [];
    return (buttons.length ? buttons : [OPEN]).map((button) => ({ address, button }));
  });
}

// The lines of smoke.md: [{ address, button, what, shot }].
export function smokeLines(body) {
  return String(body).replace(/\r\n/g, '\n').split('\n').flatMap((l) => {
    const m = /^\s*[-*]\s+(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(\S.*?)\s*$/.exec(l);
    return m ? [{ address: m[1], button: m[2], what: m[3], shot: m[4] }] : [];
  });
}

// { screens, problems: [text], ok }.
export function smokeCheck(root, id) {
  const text = orderText(root, id);
  if (text === null) return { screens: [], problems: [`no order file for ${id}`], ok: false };
  const screens = screensOf(text);
  if (!screens.length) return { screens, problems: [], ok: true };
  const dir = join(root, '.analucia', 'evidence', id);
  const file = join(dir, 'smoke.md');
  if (!existsSync(file)) return { screens, problems: [`.analucia/evidence/${id}/smoke.md is missing: one line per screen and button: "- <address> | <button> | <what happened> | <screenshot file>"`], ok: false };
  const lines = smokeLines(readFileSync(file, 'utf8'));
  const problems = [];
  for (const s of screens) {
    const line = lines.find((l) => l.address === s.address && l.button === s.button);
    if (!line) { problems.push(`${s.address} | ${s.button}: no line in smoke.md`); continue; }
    if (ERROR_WORDS.test(line.what)) problems.push(`${s.address} | ${s.button}: the line says an error happened (${JSON.stringify(line.what)})`);
    if (!existsSync(join(dir, line.shot))) problems.push(`${s.address} | ${s.button}: the screenshot ${line.shot} is not in .analucia/evidence/${id}/`);
  }
  return { screens, problems, ok: problems.length === 0 };
}

