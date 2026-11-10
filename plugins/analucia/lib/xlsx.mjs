// Minimal .xlsx (Office Open XML SpreadsheetML) writer and reader. No dependencies (zip.mjs + node:zlib).
// Writer: inline strings (or a shared-strings table), numbers, solid fills, bold header, column widths,
// wrap text, frozen header row, auto-filter, list data validation, sheet protection with unlocked input cells.
// Reader: inline strings AND shared strings (Excel rewrites files with sharedStrings.xml on save),
// numbers, booleans, formula string results; cells found by reference ("F2").
import { readZip, writeZip } from './zip.mjs';

export const colName = (i) => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
export const ref = (col, row) => `${colName(col)}${row + 1}`; // 0-based col and row

// XML text: escape, and drop characters XML 1.0 does not allow.
const xml = (s) => String(s)
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const STYLE = { plain: 0, header: 1, wrap: 2, input: 3 };
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD9D9D9"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF2A8"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1" applyAlignment="1" applyProtection="1"><alignment vertical="top" wrapText="1"/><protection locked="0"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function sheetXml(sheet, strings) {
  const rows = sheet.rows ?? [];
  const width = Math.max(1, ...rows.map((r) => r.length));
  const out = [`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet ${NS}>`];
  out.push(`<dimension ref="A1:${ref(width - 1, Math.max(0, rows.length - 1))}"/>`);
  out.push('<sheetViews><sheetView workbookViewId="0"', sheet.freeze ? '><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView>' : '/>', '</sheetViews>');
  out.push('<sheetFormatPr defaultRowHeight="15"/>');
  if (sheet.columns?.length) {
    out.push('<cols>', ...sheet.columns.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`), '</cols>');
  }
  out.push('<sheetData>');
  rows.forEach((row, r) => {
    const cells = [];
    row.forEach((cell, c) => {
      if (cell === null || cell === undefined) return;
      const { v, style = 'plain' } = typeof cell === 'object' ? cell : { v: cell };
      const s = STYLE[style] ? ` s="${STYLE[style]}"` : '';
      const at = ref(c, r);
      if (v === null || v === undefined || v === '') cells.push(`<c r="${at}"${s}/>`);
      else if (typeof v === 'number' && Number.isFinite(v)) cells.push(`<c r="${at}"${s}><v>${v}</v></c>`);
      else if (strings) {
        const text = String(v);
        if (!strings.index.has(text)) {
          strings.index.set(text, strings.list.length);
          strings.list.push(text);
        }
        strings.count++;
        cells.push(`<c r="${at}"${s} t="s"><v>${strings.index.get(text)}</v></c>`);
      } else {
        cells.push(`<c r="${at}"${s} t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`);
      }
    });
    out.push(`<row r="${r + 1}">${cells.join('')}</row>`);
  });
  out.push('</sheetData>');
  if (sheet.protect) out.push('<sheetProtection sheet="1" objects="1" scenarios="1" formatColumns="0" formatRows="0" sort="0" autoFilter="0"/>');
  if (sheet.autoFilter && rows.length) out.push(`<autoFilter ref="A1:${ref(width - 1, rows.length - 1)}"/>`);
  const v = sheet.validations ?? [];
  if (v.length) {
    out.push(`<dataValidations count="${v.length}">`);
    for (const d of v) {
      out.push(`<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="${d.ref}"><formula1>"${xml(d.list.join(','))}"</formula1></dataValidation>`);
    }
    out.push('</dataValidations>');
  }
  out.push('<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>', '</worksheet>');
  return out.join('');
}

// sheets: [{ name, columns?: [width], rows: [[cell]], freeze?, autoFilter?, protect?, validations?: [{ ref, list }] }]
// cell: string | number | null | { v, style: 'plain'|'header'|'wrap'|'input' }
// sharedStrings: true writes a sharedStrings.xml table instead of inline strings (the way Excel saves).
export function writeWorkbook(sheets, { sharedStrings = false } = {}) {
  const strings = sharedStrings ? { list: [], index: new Map(), count: 0 } : null;
  const files = [];
  const sheetFiles = sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s, strings) }));
  const filters = sheets.map((s, i) => (s.autoFilter && s.rows?.length
    ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${s.name.replace(/'/g, "''")}'!$A$1:$${colName(Math.max(1, ...s.rows.map((r) => r.length)) - 1)}$${s.rows.length}</definedName>`
    : '')).join('');
  files.push({
    name: '[Content_Types].xml',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}${strings ? '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' : ''}</Types>`,
  });
  files.push({
    name: '_rels/.rels',
    data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  });
  files.push({
    name: 'xl/workbook.xml',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook ${NS}><bookViews><workbookView activeTab="0"/></bookViews><sheets>${sheets.map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>${filters ? `<definedNames>${filters}</definedNames>` : ''}</workbook>`,
  });
  const rels = sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`);
  rels.push(`<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`);
  if (strings) rels.push(`<Relationship Id="rId${sheets.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>`);
  files.push({ name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>` });
  files.push({ name: 'xl/styles.xml', data: STYLES_XML });
  files.push(...sheetFiles);
  if (strings) {
    files.push({
      name: 'xl/sharedStrings.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.count}" uniqueCount="${strings.list.length}">${strings.list.map((t) => `<si><t xml:space="preserve">${xml(t)}</t></si>`).join('')}</sst>`,
    });
  }
  return writeZip(files);
}

// ---------- Reader ----------

const unxml = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) => {
  const k = e.toLowerCase();
  if (k === 'amp') return '&';
  if (k === 'lt') return '<';
  if (k === 'gt') return '>';
  if (k === 'quot') return '"';
  if (k === 'apos') return "'";
  return String.fromCodePoint(k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
});
// Some writers prefix SpreadsheetML elements (<x:c>); drop element prefixes so one parser fits all.
const stripPrefixes = (s) => s.replace(/<(\/?)[A-Za-z][\w.-]*:/g, '<$1');
const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
// Concatenate every <t>…</t> (plain or rich-text runs), ignoring phonetic runs <rPh>.
const texts = (s) => [...s.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)].map((m) => unxml(m[1] ?? '')).join('');

const colIndex = (letters) => [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;

function resolveTarget(target) {
  const t = target.replace(/^\//, '');
  return t.startsWith('xl/') ? t : `xl/${t}`;
}

// Buffer -> { sheets: [{ name, cells: Map(ref -> string) }], sheet(name), value(sheetName, ref) }
export function readWorkbook(buf) {
  const zip = readZip(buf);
  const get = (n) => {
    const d = zip.get(n);
    return d ? stripPrefixes(d.toString('utf8')) : null;
  };
  const workbook = get('xl/workbook.xml');
  if (!workbook) throw new Error('not a workbook: xl/workbook.xml is missing');
  const rels = new Map([...(get('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b[^>]*>/g)].map((m) => [attr(m[0], 'Id'), m[0]]));
  let shared = [];
  const sstRel = [...rels.values()].find((r) => /\/sharedStrings"/.test(r));
  const sst = get(sstRel ? resolveTarget(attr(sstRel, 'Target')) : 'xl/sharedStrings.xml');
  if (sst) shared = [...sst.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map((m) => texts(m[1] ?? ''));

  const sheets = [];
  for (const m of workbook.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const name = unxml(attr(m[0], 'name') ?? '');
    const rid = attr(m[0], 'r:id') ?? attr(m[0], 'id');
    const target = rels.get(rid) ? resolveTarget(attr(rels.get(rid), 'Target')) : `xl/worksheets/sheet${sheets.length + 1}.xml`;
    const xmlText = get(target) ?? '';
    const cells = new Map();
    let rowNo = 0;
    // Attribute part excludes "/" so a self-closing <row …/> or <c …/> never swallows the next element.
    for (const row of xmlText.matchAll(/<row\b([^>/]*)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      rowNo = Number(attr(row[0], 'r') ?? rowNo + 1);
      let colNo = -1;
      for (const c of (row[2] ?? '').matchAll(/<c\b([^>/]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const tag = `<c${c[1]}>`;
        const r = attr(tag, 'r');
        colNo = r ? colIndex(/^[A-Z]+/.exec(r)[0]) : colNo + 1;
        const at = r ?? ref(colNo, rowNo - 1);
        const t = attr(tag, 't');
        const body = c[2] ?? '';
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        let value;
        if (t === 's') value = shared[Number(v)] ?? '';
        else if (t === 'inlineStr') value = texts(/<is>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? '');
        else if (t === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
        else value = v === undefined ? '' : unxml(v);
        if (value !== '') cells.set(at, value);
      }
    }
    sheets.push({ name, cells });
  }
  return {
    sheets,
    sheet: (name) => sheets.find((s) => s.name === name),
    value: (sheetName, at) => sheets.find((s) => s.name === sheetName)?.cells.get(at) ?? '',
  };
}
