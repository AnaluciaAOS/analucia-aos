// ORD-0047 part 1 (OBS-201): evidence in the published site for a promise the owner will see. An order passed all its
// checks while the screen it promised showed no data: the checks read the code, not the page. `aos live check` reads the
// published page with Node's own fetch and fails when the text is not there, when a total or a base does not hold, and
// whenever the page shows a "not available" placeholder (unless the order says the placeholder is expected).

// One list of the phrases a page shows in place of data, in five locales (en, es, pt, zh-Hans, hi), compared in lower case.
export const PLACEHOLDERS = [
  'not available', 'unavailable', 'no data', 'source not available', 'data not available', 'n/a', 'coming soon', 'no results',
  'no disponible', 'fuente no disponible', 'sin datos', 'no hay datos', 'próximamente', 'sin resultados',
  'indisponível', 'não disponível', 'fonte não disponível', 'sem dados', 'em breve', 'sem resultados',
  '不可用', '暂无数据', '无数据', '数据不可用', '暂无', '即将推出',
  'उपलब्ध नहीं', 'डेटा उपलब्ध नहीं', 'कोई डेटा नहीं', 'जल्द आ रहा है', 'कोई परिणाम नहीं',
];

const TOTAL_LABELS = ['total', 'totales', 'total de', '总计', '合计', 'कुल'];
const BASE_LABELS = ['base', 'muestra', 'n =', 'n=', 'amostra', 'sample', '基数', '样本', 'आधार'];

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
// The visible text of an HTML page, in one line of single spaces.
export function visibleText(html) {
  return String(html)
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|nbsp|#39);/g, (m) => ENTITIES[m])
    .replace(/\s+/g, ' ')
    .trim();
}

// The placeholder phrases found in a text (lower-cased comparison; "n/a" only as a whole word).
export function placeholdersIn(text) {
  const low = String(text).toLowerCase();
  return PLACEHOLDERS.filter((p) => (p === 'n/a' ? /(^|[^a-z0-9])n\/a($|[^a-z0-9])/.test(low) : low.includes(p)));
}

// A number written with thousand separators or a decimal comma becomes a plain number; null when it is not one.
export function toNumber(s) {
  let t = String(s).trim().replace(/\s/g, '');
  if (!/^\d[\d.,]*$/.test(t)) return null;
  if (/[.,]\d{3}(?![\d])/.test(t) && !/[.,]\d{1,2}$/.test(t)) t = t.replace(/[.,]/g, '');
  else t = t.replace(/,(\d{1,2})$/, '.$1').replace(/,/g, '');
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// The numbers written right after one of the labels: "Total: 1,250", "base n=300".
export function valuesAfter(text, labels) {
  const found = [];
  const low = String(text).toLowerCase();
  for (const label of labels) {
    let from = 0;
    for (;;) {
      const at = low.indexOf(label, from);
      if (at === -1) break;
      from = at + label.length;
      const m = /^[^\d]{0,12}(\d[\d.,]*)/.exec(String(text).slice(from, from + 40));
      const n = m ? toNumber(m[1].replace(/[.,]$/, '')) : null;
      if (n !== null) found.push(n);
    }
  }
  return found;
}

// The expectation is a text, or a pattern written /like this/flags.
export function matcher(expect) {
  const m = /^\/(.+)\/([a-z]*)$/s.exec(expect);
  if (m) {
    const re = new RegExp(m[1], m[2]);
    return { found: (text) => re.exec(text)?.[0] ?? null };
  }
  const want = expect.normalize('NFC').toLowerCase();
  return { found: (text) => (text.normalize('NFC').toLowerCase().includes(want) ? expect : null) };
}

// Fetches the page and judges it. Returns { ok, lines: [what it found and what failed], text }.
export async function liveCheck({ url, expect, total, base, placeholderOk = false, fetchFn = globalThis.fetch, timeoutMs = 20000 }) {
  const lines = [];
  let ok = true;
  const fail = (line) => { ok = false; lines.push(`FAIL ${line}`); };
  let html;
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    if (!res.ok) { fail(`${url} answered ${res.status}`); return { ok, lines, text: '' }; }
    html = await res.text();
  } catch (x) {
    fail(`${url} could not be read: ${x.message}`);
    return { ok, lines, text: '' };
  }
  const text = visibleText(html);
  lines.push(`read ${url}: ${text.length} characters of visible text`);
  if (expect !== undefined) {
    const hit = matcher(expect).found(text);
    if (hit === null) fail(`expected text not found: ${JSON.stringify(expect)}`);
    else lines.push(`found ${JSON.stringify(hit)}`);
  }
  for (const [name, want, labels] of [['total', total, TOTAL_LABELS], ['base', base, BASE_LABELS]]) {
    if (want === undefined) continue;
    const seen = valuesAfter(text, labels);
    if (!seen.length) fail(`${name} ${want} asked and no ${name} is shown on the page`);
    else if (!seen.includes(Number(want))) fail(`${name} ${want} asked, the page shows ${[...new Set(seen)].join(', ')}`);
    else lines.push(`${name} ${want}: found`);
  }
  const holders = placeholdersIn(text);
  if (holders.length && !placeholderOk) fail(`the page shows a "not available" placeholder (${holders.map((h) => JSON.stringify(h)).join(', ')}): a promise of data is not met by a placeholder; if the order says a placeholder is expected, add --placeholder-ok`);
  else if (holders.length) lines.push(`placeholder accepted (--placeholder-ok): ${holders.join(', ')}`);
  return { ok, lines, text };
}
