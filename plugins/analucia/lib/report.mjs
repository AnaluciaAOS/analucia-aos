// ORD-0043 part 13 (OBS-169): the lines a report must carry come from the verify file. A verify file may carry
// `report_lines`, a list of { name, pattern } (a regular expression of one line). `aos verify` checks each one
// against the report of the order as a check of class form; `aos report template <ID>` prints the skeleton of the
// report with one line per entry; `aos report check <ID>` tries only those lines and the fixed sections on the report
// as it is, and changes no state; `aos run finish --outcome done` refuses while a line is missing (E_REPORT_LINES).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const reportRel = (id) => `.analucia/evidence/${id}/report.md`;
const TEMPLATE = fileURLToPath(new URL('../templates/report.md', import.meta.url));

// The fixed sections of every report (templates/report.md): the section of evidence, the line that says whether the
// work is complete, and the outcome on the last line.
export const FIXED_SECTIONS = [
  { name: 'the section "## Evidencia"', test: (lines) => lines.some((l) => /^## Evidencia\s*$/.test(l)) },
  { name: 'the line "Work: complete" or "Work: not complete"', test: (lines) => lines.some((l) => /^Work: (complete|not complete)$/.test(l)) },
  { name: 'the last line "OUTCOME: <outcome>"', test: (lines) => /^OUTCOME: \S+/.test(lines.filter((l) => l.trim()).at(-1) ?? '') },
];

// The `report_lines` of the verify file of an order (placed, or the draft's), or [] when it has none or no file.
export function reportLinesOf(root, id) {
  for (const rel of [`.analucia/verify/${id}.json`, `.analucia/drafts/${id}.json`]) {
    const p = join(root, rel);
    if (!existsSync(p)) continue;
    try {
      const v = JSON.parse(readFileSync(p, 'utf8'));
      return Array.isArray(v.report_lines) ? v.report_lines.filter((x) => x && typeof x.name === 'string' && typeof x.pattern === 'string') : [];
    } catch { return []; }
  }
  return [];
}

const linesOf = (text) => String(text).replace(/\r\n/g, '\n').split('\n');
const compiled = (pattern) => {
  try { return new RegExp(pattern); } catch { return null; }
};

// The entries of `entries` that no line of the report matches. A pattern that is not a regular expression matches nothing.
export function missingLines(text, entries) {
  const lines = linesOf(text);
  return entries.filter(({ pattern }) => {
    const re = compiled(pattern);
    return !re || !lines.some((l) => re.test(l));
  });
}
export const missingSections = (text) => FIXED_SECTIONS.filter((s) => !s.test(linesOf(text))).map((s) => s.name);

// aos report check <ID> (and `aos run finish --outcome done`, which names its own evidence file): what the report as
// it is lacks. { path, exists, entries, lines: [missing { name, pattern }], sections: [missing fixed sections] }.
export function reportCheck(root, id, { path = reportRel(id) } = {}) {
  const entries = reportLinesOf(root, id);
  const p = join(root, path);
  let text = null;
  try { text = existsSync(p) ? readFileSync(p, 'utf8') : null; } catch { text = null; }
  if (text === null) return { path, exists: false, entries, lines: entries, sections: FIXED_SECTIONS.map((s) => s.name) };
  return { path, exists: true, entries, lines: missingLines(text, entries), sections: missingSections(text) };
}

// One missing line, as it is printed: its name and the form it must have.
export const missingLine = ({ name, pattern }) => `${name} (a line that matches ${pattern})`;

// aos report template <ID>: the skeleton of the report, with the fixed sections and one line to fill per entry.
export function reportTemplate(root, id) {
  const entries = reportLinesOf(root, id);
  const text = readFileSync(TEMPLATE, 'utf8').replace(/\r\n/g, '\n').split('ORD-NNNN').join(id);
  if (!entries.length) return text;
  const block = [
    '## Lines this report must carry',
    '',
    `<From the verify file of ${id} (report_lines). Write each line in its exact form, anywhere in the report; check with: aos report check ${id}>`,
    '',
    ...entries.map((e) => `<${e.name}: a line that matches ${e.pattern}>`),
    '',
    '',
  ].join('\n');
  const at = text.indexOf('## Evidencia');
  return at < 0 ? `${text}\n${block}` : text.slice(0, at) + block + text.slice(at);
}
