// A small Markdown renderer for the owner's review page (ORD-0024 part D). No dependency.
// Subset: headings, paragraphs, lists (- * 1.), tables, fenced and inline code, bold, links. Every character of the
// document is HTML-escaped first; only the tags written here are produced. Links keep http(s), mailto, relative paths
// and anchors; any other scheme (javascript:, data:, …) is shown as text.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

export const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const SAFE_HREF = /^(?:https?:\/\/|mailto:|#|\.{0,2}\/|[\w.-]+(?:\/|$|\.))/i;

// Inline markup on one escaped line: code first (its content is not formatted), then links, then bold.
function inline(text) {
  const parts = text.split(/(`[^`]+`)/);
  return parts.map((p) => {
    if (/^`[^`]+`$/.test(p)) return `<code>${escapeHtml(p.slice(1, -1))}</code>`;
    let s = escapeHtml(p);
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
      const raw = href.replace(/&amp;/g, '&');
      return SAFE_HREF.test(raw) && !/^\s*(?:javascript|data|vbscript):/i.test(raw) ? `<a href="${href}">${label}</a>` : m;
    });
    return s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  }).join('');
}

const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const isSeparator = (line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);

export function renderMarkdown(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = /^```/.exec(line);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push(`<h${h[1].length}>${inline(h[2].trim())}</h${h[1].length}>`);
      i++;
      continue;
    }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    const item = /^\s*(?:([-*])|(\d+)\.)\s+(.*)$/;
    if (item.test(line)) {
      const ordered = Boolean(item.exec(line)[2]);
      const items = [];
      while (i < lines.length && item.test(lines[i]) && Boolean(item.exec(lines[i])[2]) === ordered) items.push(item.exec(lines[i++])[3]);
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((x) => `<li>${inline(x)}</li>`).join('')}</${tag}>`);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*(?:[-*]|\d+\.)\s)/.test(lines[i]) && !(/^\s*\|/.test(lines[i]) && i + 1 < lines.length && isSeparator(lines[i + 1]))) para.push(lines[i++].trim());
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('\n');
}

const STYLE = `:root{color-scheme:light dark;--bg:#fbfaf7;--fg:#1d1d1b;--muted:#5b5b57;--line:#e2dfd8;--code:#f0eee8;--accent:#2f5d50}
@media (prefers-color-scheme:dark){:root{--bg:#161715;--fg:#ecebe6;--muted:#a9a8a1;--line:#2e302c;--code:#22241f;--accent:#8cc4b2}}
body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:46rem;margin:0 auto;padding:2rem 16px 3rem}.meta{color:var(--muted);font-size:.9rem;border-bottom:1px solid var(--line);padding-bottom:.75rem;margin-bottom:1.5rem}
h1{font-size:1.8rem;line-height:1.2}h2{font-size:1.3rem;margin-top:2rem}table{border-collapse:collapse;width:100%;display:block;overflow-x:auto}
th,td{border:1px solid var(--line);padding:.4rem .6rem;text-align:left;vertical-align:top}th{background:var(--code)}
code{font:.9em ui-monospace,Consolas,monospace;background:var(--code);padding:0 .2rem;border-radius:3px}pre{background:var(--code);padding:.75rem;overflow-x:auto;border-radius:6px}pre code{padding:0}a{color:var(--accent)}`;

export function reviewPage(text, { title, meta = '' } = {}) {
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${escapeHtml(title ?? 'Document')}</title>\n<style>${STYLE}</style>\n</head>\n<body>\n<main>\n${meta ? `<p class="meta">${escapeHtml(meta)}</p>\n` : ''}${renderMarkdown(text)}\n</main>\n</body>\n</html>\n`;
}

// Writes the page into a new folder under the system temp directory (never into the repository) and returns its path.
export function writeReviewPage(text, { name = 'document.md', title, meta, dir = tmpdir() } = {}) {
  const folder = mkdtempSync(join(dir, 'aos-review-'));
  const file = join(folder, `${basename(name).replace(/\.[^.]*$/, '') || 'document'}.html`);
  writeFileSync(file, reviewPage(text, { title, meta }));
  return file;
}
