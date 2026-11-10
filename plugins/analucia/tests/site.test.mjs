// ORD-0025 (replaces the ORD-0021 site): the public page from the approved mockup — five views, contact address,
// privacy note, no external requests, content rules, one place for the product name, accessibility basics.
// ORD-0026: launch polish — sticky action, copy buttons, interactive steps, active nav, motion, prerequisites,
// loop diagram and sample orders panel, the name "Analucia AOS" and the organization AnaluciaAOS.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SITE = fileURLToPath(new URL('../../../site/', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CONTACT = 'hello@analuciaaos.com';
// The owner's GitHub account is owner configuration (.analucia/project.json, kept out of the public tree, ORD-0030):
// when it is present, no site file may show it; a public checkout has no such file and skips this check.
const OWNER = (() => { try { return JSON.parse(readFileSync(join(ROOT, '.analucia', 'project.json'), 'utf8')).github_owner?.toLowerCase() || null; } catch { return null; } })();
const showsOwner = (text) => Boolean(OWNER) && text.toLowerCase().includes(OWNER);
const all = () => readdirSync(SITE, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name); // the files at the top; the language folders are checked below (ORD-0027)
const pages = () => all().filter((f) => f.endsWith('.html'));
const read = (f) => readFileSync(join(SITE, f), 'utf8').replace(/\r\n/g, '\n'); // a CRLF checkout (core.autocrlf) is the same file
// The visible text: <code> blocks (the exact install commands) and tags removed, the contact address and domain left out.
const prose = (html) => html.replace(/<script>[\s\S]*?<\/script>/g, ' ').replace(/<code[^>]*>[\s\S]*?<\/code>/g, ' ').replace(/<[^>]+>/g, ' ').replaceAll(CONTACT, ' ').replaceAll('analuciaaos.com', ' ');

// Content rules (ORD-0021, kept by ORD-0025): places, people, business examples, money figures, licence terms,
// promises, tracking. The project's business-specific terms are on the release guard's denylist (which scans every
// tracked file, site/ included) and in the verify file's grep, so they are not repeated here.
const FORBIDDEN = [
  /\bper[uú]\b/, /\blima\b/, /trujillo/, /\bspain\b/, /m[eé]xico/, /colombia/, /\bchile\b/, /argentin/, /bra[sz]il/, /\bindia\b/, /\bchina\b/,
  /\beurope\b/, /united states/, /\busa\b/, /auto parts/,
  /erwing/, /reyes/, /arrun[aá]tegui/,
  /\$\s?\d/, /\d\s?\$/, /€/, /£/, /\b\d+(?:[.,]\d+)?\s?(?:usd|eur|dollars?|euros?)\b/, /\bper month\b.*\d/, /\bsubscription/, /\bdiscount/, /\bfee\b/,
  /\blicen[cs]e/, /\btokens?\b/,
  /guarantee/, /\bsav(e|es|ing|ings) (you|money|time)\b/, /\broi\b/, /\d+\s?%/, /\bboost/, /\b\d+x\b/, /\bfaster\b/, /\bcustomers? (say|love)/,
  /analytics/, /gtag/, /googletagmanager/, /tracking pixel/,
];

test('one scrolling page with the six views in order and the five navigation anchors (ORD-0032: the pricing view)', () => {
  const html = read('index.html');
  assert.deepEqual([...html.matchAll(/<section class="view[^"]*" id="([^"]+)"/g)].map((m) => m[1]), ['top', 'how', 'loop', 'see', 'start', 'pricing']);
  const nav = /<nav aria-label="Sections">([\s\S]*?)<\/nav>/.exec(html)[1];
  assert.deepEqual([...nav.matchAll(/<a href="#([^"]+)">([^<]+)<\/a>/g)].map((m) => [m[1], m[2]]), [['how', 'How it works'], ['see', 'What you see'], ['start', 'Get started'], ['pricing', 'Pricing'], ['talk', 'Talk to us']]);
  for (const t of ['Hand the work to AI.', 'Keep the decisions.', 'Three roles.', 'One of them is you.', 'Six steps.', 'Every one leaves a trace.', 'One screen to decide.', 'Plain words.', 'Four steps.', 'Then your first hour.', 'Rule of the loop:', 'Tamper-evident log.', 'Honest limits']) {
    assert.ok(html.includes(t), t);
  }
});

test('every link resolves: local files and anchors, and mail only to the contact address', () => {
  for (const p of pages()) {
    const html = read(p);
    for (const [, ref] of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
      if (ref.startsWith('mailto:')) {
        assert.match(ref, new RegExp(`^mailto:${CONTACT.replace('.', '\\.')}(\\?subject=[A-Za-z0-9%-]+)?$`), `${p}: ${ref}`);
        continue;
      }
      assert.doesNotMatch(ref, /^[a-z]+:/i, `${p}: ${ref} leaves the site`);
      const [file, anchor] = ref.split('#');
      const target = file || p;
      assert.ok(existsSync(join(SITE, target)), `${p}: ${ref} → missing file`);
      if (anchor) assert.match(read(target), new RegExp(`\\sid="${anchor}"`), `${p}: ${ref} → missing anchor`);
    }
  }
  const html = read('index.html');
  assert.equal((html.match(/href="mailto:hello@analuciaaos\.com\?subject=30-minute%20diagnostic"/g) ?? []).length, 5, 'the five diagnostic buttons (header, hero, get started, the onboarding card of the pricing view, phone bar) are mailto links with a subject');
  assert.doesNotMatch(html, /<form|<input|<textarea/i, 'no form');
});

test('nothing is loaded from other sites: no external src, url(), @import, script file, frame or font', () => {
  for (const f of all()) {
    const t = read(f);
    assert.doesNotMatch(t, /(?:src|srcset|href)\s*=\s*"?https?:/i, f);
    assert.doesNotMatch(t, /url\(\s*['"]?https?:/i, f);
    assert.doesNotMatch(t, /@import|@font-face|<script[^>]*\ssrc|<iframe|<object|<embed/i, f);
    assert.ok((t.match(/<script/gi) ?? []).length <= (f === 'index.html' ? 1 : 0), `${f}: at most the one inline script of index.html`);
  }
});

test('contact: the placeholder is gone and the only address on the site is the contact address', () => {
  for (const f of all()) {
    const t = read(f);
    assert.ok(!t.includes('{{CONTACT_EMAIL}}') && !t.includes('your-domain'), f);
    for (const m of t.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) assert.equal(m[0], CONTACT, f);
  }
  assert.ok(read('index.html').includes(CONTACT));
});

test('no forbidden word, no price figure; the view-4 table shows no numbers', () => {
  for (const f of pages()) {
    const text = prose(read(f));
    for (const re of FORBIDDEN) {
      const m = new RegExp(re.source, `${re.flags.replace('i', '')}i`).exec(text);
      assert.equal(m, null, `${f}: forbidden ${re} matched ${JSON.stringify(m?.[0])}`);
    }
  }
  const table = /<table>([\s\S]*?)<\/table>/.exec(read('index.html'))[1];
  assert.doesNotMatch(table.replace(/<[^>]+>/g, ' '), /\d/, 'no number in the decision-brief table');
  assert.match(table, /Monthly cost[\s\S]*Who runs it/);
});

test('the install commands are real: read from README.md, .claude-plugin/marketplace.json and the plugin manifest', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const market = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
  const plugin = JSON.parse(readFileSync(join(ROOT, 'plugins', 'analucia', '.claude-plugin', 'plugin.json'), 'utf8'));
  const html = read('index.html');
  const code = (id) => new RegExp(`<code id="${id}">([^<]+)</code>`).exec(html)[1];
  // ORD-0026 F: the organization AnaluciaAOS, the marketplace and plugin names from the manifests.
  assert.equal(code('c-add'), `claude plugin marketplace add AnaluciaAOS/${market.name}`);
  assert.equal(code('c-install'), `claude plugin install ${plugin.name}@${market.name} --scope project`);
  for (const c of [code('c-add'), code('c-install')]) assert.ok(readme.includes(c), `README.md has ${c}`);
  // ORD-0026 G: step 3 never asks for the long cache path.
  assert.doesNotMatch(html, /plugins\/cache|aos\.mjs/);
  assert.ok(existsSync(join(ROOT, 'plugins', 'analucia', 'bin', 'aos.mjs')));
  assert.doesNotMatch(read('index.html'), /&lt;repository&gt;/);
});

test('the product name is written in one place only (site/style.css)', () => {
  for (const f of all().filter((x) => /\.(html|css)$/.test(x))) {
    const text = f.endsWith('.html') ? prose(read(f)) : read(f);
    assert.equal((text.match(/analucia/gi) ?? []).length, f === 'style.css' ? 1 : 0, f);
  }
  assert.match(read('style.css'), /--product-name: "Analucia AOS";/);
  for (const f of all()) assert.ok(!showsOwner(read(f)), `${f}: the old owner is not shown`);
  for (const f of pages()) assert.equal((read(f).match(/class="name"/g) ?? []).length, 2, `${f}: the name appears in the header and the footer, from the one variable`);
});

// WCAG 2 relative luminance and contrast ratio of two #rrggbb colours.
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('accessibility basics: lang, title, description, viewport, skip link, one h1, visible focus, text contrast AA', () => {
  for (const p of pages()) {
    const html = read(p);
    assert.match(html, /<html lang="en"( class="no-js")?>/, p);
    assert.match(html, /<title>[^<]+<\/title>/, p);
    assert.match(html, /<meta name="description" content="[^"]+">/, p);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/, p);
    assert.match(html, /<a class="skip" href="#main">/, p);
    assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 1, p);
  }
  const css = read('style.css');
  assert.match(css, /:focus-visible[^{]*\{[^}]*outline: 3px solid/);
  const token = (n) => new RegExp(`--${n}: (#[0-9a-f]{6});`).exec(css)[1];
  const pairs = [['ink', 'bg'], ['mut', 'bg'], ['mut', 'card'], ['acc', 'bg'], ['acc', 'card'], ['ink', 'accbg'], ['mut', 'accbg'], ['ink', 'card']];
  for (const [fg, bg] of pairs) assert.ok(ratio(token(fg), token(bg)) >= 4.5, `${fg} on ${bg}: ${ratio(token(fg), token(bg)).toFixed(2)}`);
  assert.ok(ratio('#ffffff', token('acc')) >= 4.5, 'white on the accent button');
  assert.ok(ratio('#f6f3ec', token('ink')) >= 4.5 && ratio('#8fd3bf', token('ink')) >= 4.5, 'the dark band');
  assert.ok(ratio('#cfe6dc', token('term')) >= 4.5 && ratio('#9aa8b2', token('term')) >= 4.5 && ratio('#e8c872', token('term')) >= 4.5, 'the terminal');
  assert.match(css, /@media \(min-width: 900px\)/, 'the layout changes between phone and desktop');
});

test('privacy page, robots.txt and .htaccess as ORD-0025 asks', () => {
  const p = read('privacy.html');
  assert.ok(p.includes('Draft — to be reviewed by the owner\'s lawyer (ORD-0013)'));
  for (const s of ['It sets no cookies.', 'It loads nothing from other sites', 'is used only to answer your message', 'To ask us to delete the messages']) assert.ok(p.includes(s), s);
  assert.doesNotMatch(prose(p), /\b(?:GDPR|compliant|compliance|certified)\b/i, 'no claim of legal compliance');
  assert.equal(read('robots.txt'), 'User-agent: *\nAllow: /\n');
  const h = read('.htaccess');
  assert.match(h, /^Options -Indexes$/m);
  assert.match(h, /Header always set X-Content-Type-Options "nosniff"/);
  assert.match(h, /Header always set Referrer-Policy "strict-origin-when-cross-origin"/);
  assert.doesNotMatch(h, /^\s*Rewrite/m, 'the HTTPS redirect stays in docs/SITE-DEPLOY.md until the certificate shows');
  const deploy = readFileSync(join(ROOT, 'docs', 'SITE-DEPLOY.md'), 'utf8');
  assert.match(deploy, /RewriteCond %\{HTTPS\} !=on/);
  assert.match(deploy, /analuciaaos\.com/);
});

// ---------- ORD-0026 ----------

const index = () => read('index.html');
const script = () => /<script>([\s\S]*?)<\/script>/.exec(index())[1];

test('the one inline script: under 6 KB, no storage, no cookies, no requests, and it only enhances', () => {
  assert.ok(Buffer.byteLength(script()) < 6 * 1024, `${Buffer.byteLength(script())} bytes`);
  for (const f of all()) assert.doesNotMatch(read(f), /localStorage|sessionStorage|indexedDB|document\.cookie|fetch\(|XMLHttpRequest|sendBeacon|WebSocket|import\(/, f);
  assert.match(index(), /<html lang="en" class="no-js">/);
  assert.match(script(), /document\.documentElement\.className = 'js'/);
});

test('A: the diagnostic button is always in reach: sticky header on desktop, a bottom bar on phones that never covers the footer', () => {
  const css = read('style.css');
  assert.match(index(), /<header class="topbar">[\s\S]*class="btn btn-sm cta-top" href="mailto:hello@analuciaaos\.com\?subject=30-minute%20diagnostic"/);
  assert.match(index(), /<div class="cta-bar"><a class="btn" href="mailto:hello@analuciaaos\.com\?subject=30-minute%20diagnostic">/);
  assert.match(css, /@media \(min-width: 900px\) \{\n {2}\.topbar \{ position: sticky; top: 0;/);
  assert.match(css, /@media \(max-width: 899px\) \{\n {2}\.cta-bar \{ position: fixed;[^}]*bottom: 0;[\s\S]*body \{ padding-bottom: 84px; \}/);
});

test('B: every command has a real Copy button that copies it, says Copied for two seconds, and falls back to selecting', () => {
  const html = index();
  for (const id of ['c-git', 'c-node', 'c-add', 'c-install']) assert.match(html, new RegExp(`<button type="button" class="copy" data-copy="${id}" hidden>Copy</button>`), id);
  assert.match(html, /<p class="sr-only" id="copy-status" aria-live="polite"><\/p>/);
  assert.match(script(), /navigator\.clipboard\.writeText\(code\.textContent\)/);
  assert.match(script(), /b\.textContent = 'Copied'[\s\S]*setTimeout\(function \(\) \{ b\.textContent = 'Copy'; \}, 2000\)/);
  assert.match(script(), /createRange\(\)[\s\S]*addRange/);
});

test('C: the six steps open an example (aria-expanded, aria-controls); without JavaScript every example is already open', () => {
  const html = index();
  const toggles = [...html.matchAll(/<button class="step-toggle" type="button" aria-controls="(ex-\d)" aria-expanded="true">/g)].map((m) => m[1]);
  assert.deepEqual(toggles, ['ex-1', 'ex-2', 'ex-3', 'ex-4', 'ex-5', 'ex-6']);
  for (const id of toggles) {
    const ex = new RegExp(`<p class="example" id="${id}">([^<]+)</p>`).exec(html);
    assert.ok(ex && ex[1].length > 30, id);
    assert.doesNotMatch(ex[1], /\d/, `${id}: no figures`);
  }
  assert.match(script(), /setAttribute\('aria-expanded', 'false'\); ex\.hidden = true;/);
});

test('D and E: smooth scrolling, the active nav link from IntersectionObserver, subtle motion off under reduced motion', () => {
  const css = read('style.css');
  assert.match(css, /html \{ scroll-behavior: smooth;/);
  assert.match(script(), /new IntersectionObserver/);
  assert.match(script(), /classList\.toggle\('is-active', on\)/);
  assert.match(css, /\.nav ul a\.is-active \{/);
  assert.match(css, /\.card:hover \{/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\n {2}html \{ scroll-behavior: auto; \}\n {2}\*, \*::before, \*::after \{ transition: none !important; animation: none !important; \}/);
  assert.doesNotMatch(script(), /wheel|preventDefault|scrollTo/, 'no scroll-jacking');
});

test('G: "Before you start" comes before the install steps, with the checks, the time and what is not needed', () => {
  const html = index();
  assert.ok(html.indexOf('Before you start') < html.indexOf('Add the plugin'));
  for (const t of ['<strong>Git</strong>', '<strong>Node.js LTS</strong>, a free program the Loop uses internally, installed once', '“Windows Installer (.msi)” button and accept the defaults', 'on macOS use the macOS installer', 'on Linux', '<strong>Claude Code</strong>, signed in', 'only if you want a chat with a connected folder', 'An empty project folder', 'About 10 to 15 minutes if you install only these.', 'You do not need Chocolatey, Visual Studio, Python or Docker.', '<code id="c-git">git --version</code>', '<code id="c-node">node --version</code>']) {
    assert.ok(html.includes(t), t);
  }
  assert.match(html, /Open Claude Code in that same folder<span class="hint">Not in a subfolder/); // ORD-0032 A.1: no more "nothing to type"
});

test('H: the loop diagram is inline SVG with six steps, a gate, a dashed return, a legend, descriptions and an actor filter', () => {
  const html = index();
  const svg = /<svg class="flow"[\s\S]*?<\/svg>/.exec(html)[0];
  assert.deepEqual([...svg.matchAll(/<g data-step="(\w+)" data-actor="(\w+)">/g)].map((m) => [m[1], m[2]]),
    [['order', 'person'], ['admit', 'auto'], ['build', 'auto'], ['verify', 'gate'], ['deliver', 'deliverable'], ['sign', 'person']]);
  assert.match(svg, /<path class="n gate" d="M/, 'verify is a diamond');
  assert.match(svg, /class="loopback"/);
  assert.match(svg, /continuous improvement/);
  assert.match(svg, /role="img" aria-labelledby="flow-svg-t flow-svg-d"/);
  assert.equal((html.match(/<li data-step="\w+" data-actor="\w+"><strong>/g) ?? []).length, 6, 'the six descriptions stay visible without JavaScript');
  assert.equal((html.match(/<i class="sw /g) ?? []).length, 5, 'legend: person, automatic, gate, deliverable, improvement');
  assert.deepEqual([...html.matchAll(/data-filter="(\w+)"/g)].map((m) => m[1]), ['all', 'person', 'auto', 'gate', 'deliverable']);
  assert.match(html, /<p class="flow-info" id="flow-info" aria-live="polite">/);
});

test('H: the sample orders panel says Example, shows the four states and an intact chain, and no figure', () => {
  const html = index();
  const panel = /<figure class="panel orders"[\s\S]*?<\/figure>/.exec(html)[0];
  assert.match(panel, /Orders panel · Example/);
  assert.deepEqual([...panel.matchAll(/<span class="st (\w+)">/g)].map((m) => m[1]), ['closed', 'delivered', 'running', 'blocked']);
  assert.match(panel, /chain intact ✓/);
  assert.doesNotMatch(panel.replace(/<[^>]+>/g, ' ').replace(/ORD-\d{4}/g, ' '), /\d/, 'only the example order ids have digits');
});

test('I: docs/MIGRATION.md is one page with the steps of a move', () => {
  const m = readFileSync(join(ROOT, 'docs', 'MIGRATION.md'), 'utf8').replace(/\r\n/g, '\n');
  for (const t of ['aos.mjs backup', 'aos.mjs verify-log', 'secrets by hand', 'git remote set-url origin', 'git ls-remote origin', 'Rotate any token', 'password manager', 'Never commit it', 'aos migrate --check']) assert.ok(m.includes(t), t);
  assert.ok(m.split('\n').length < 70, 'one page');
});

// ---------- ORD-0027 ----------

const LANGS = [['index.html', 'en', ''], ['es/index.html', 'es', '../'], ['pt/index.html', 'pt-BR', '../'], ['hi/index.html', 'hi', '../']];
const scriptOf = (html) => /<script>([\s\S]*?)<\/script>/.exec(html)[1];
// The layout of a page: its ids, classes and data attributes in order (the review notice of a translation left out).
const skeleton = (html) => [...html.matchAll(/\s(id|data-step|data-actor|data-filter|data-copy|data-copy-email|aria-controls|class)="([^"]*)"/g)]
  .map((m) => `${m[1]}=${m[2]}`).filter((x) => x !== 'class=wrap transnote' && x !== 'id=translation-note').join(' ');

test('ORD-0027 C: four language pages with the same layout, lang set, hreflang alternates and a plain-link language selector', () => {
  const en = skeleton(index());
  for (const [p, lang, up] of LANGS) {
    const html = read(p);
    assert.match(html, new RegExp(`<html lang="${lang}" class="no-js">`), p);
    assert.equal(skeleton(html), en, `${p}: the same elements, ids and classes as the English page`);
    const alt = [...html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(alt.map((a) => a[0]), ['en', 'es', 'pt-BR', 'hi', 'x-default'], p);
    for (const [, href] of alt) assert.ok(existsSync(join(SITE, p, '..', href)), `${p}: ${href}`);
    const nav = /<nav class="langs" aria-label="[^"]+">([\s\S]*?)<\/nav>/.exec(html)[1];
    assert.deepEqual([...nav.matchAll(/<a href="([^"]+)" hreflang="[^"]+" lang="([^"]+)"( aria-current="page")?>([^<]+)<\/a>/g)].map((m) => [m[2], m[4], Boolean(m[3])]),
      [['en', 'English', lang === 'en'], ['es', 'Español', lang === 'es'], ['pt-BR', 'Português', lang === 'pt-BR'], ['hi', 'हिन्दी', lang === 'hi']], p);
    assert.match(html, new RegExp(`<link rel="stylesheet" href="${up}style\\.css">`), p);
    assert.match(html, new RegExp(`href="${up}privacy\\.html"`), `${p}: links to the English privacy page`);
    assert.equal((html.match(/id="translation-note"/g) ?? []).length, lang === 'en' ? 0 : 1, `${p}: the review notice, in one place`);
    // The commands stay in English everywhere.
    for (const id of ['c-git', 'c-node', 'c-add', 'c-install']) {
      const code = (h) => new RegExp(`<code id="${id}">([^<]+)</code>`).exec(h)[1];
      assert.equal(code(html), code(index()), `${p}: ${id}`);
    }
    // The same rules as the English page: links, contact, outside requests, the name, content.
    for (const [, ref] of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
      if (ref.startsWith('mailto:')) { assert.match(ref, /^mailto:hello@analuciaaos\.com(\?subject=[A-Za-z0-9%-]+)?$/, `${p}: ${ref}`); continue; }
      assert.doesNotMatch(ref, /^[a-z]+:/i, `${p}: ${ref} leaves the site`);
      const [file, anchor] = ref.split('#');
      const target = file ? join(p, '..', file) : p;
      assert.ok(existsSync(join(SITE, target)), `${p}: ${ref}`);
      if (anchor) assert.match(read(target), new RegExp(`\\sid="${anchor}"`), `${p}: ${ref}`);
    }
    for (const m of html.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) assert.equal(m[0], CONTACT, p);
    assert.doesNotMatch(html, /(?:src|srcset|href)\s*=\s*"?https?:|url\(\s*['"]?https?:|@import|@font-face|<script[^>]*\ssrc|<iframe|<form|<input/i, p);
    assert.equal((html.match(/<script/g) ?? []).length, 1, p);
    assert.equal((prose(html).match(/analucia/gi) ?? []).length, 0, p);
    assert.equal((html.match(/class="name"/g) ?? []).length, 2, p);
    assert.ok(!showsOwner(html), p);
    const text = prose(html);
    for (const re of FORBIDDEN) assert.equal(new RegExp(re.source, 'i').exec(text), null, `${p}: forbidden ${re}`);
    assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 1, p);
    const s = scriptOf(html);
    assert.ok(Buffer.byteLength(s) < 7 * 1024, `${p}: ${Buffer.byteLength(s)} bytes`);
    assert.doesNotMatch(html, /localStorage|sessionStorage|indexedDB|document\.cookie|fetch\(|XMLHttpRequest|sendBeacon|WebSocket|import\(/, p);
  }
  const css = read('style.css');
  assert.match(css, /html:lang\(hi\) \{ --serif: "Noto Sans Devanagari", "Nirmala UI", "Mangal", sans-serif; --sans: "Noto Sans Devanagari", "Nirmala UI", "Mangal", sans-serif; \}/);
  assert.match(css, /html:lang\(hi\) body \* \{ letter-spacing: normal !important; \}/);
  assert.match(css, /html:lang\(hi\) h1 \{ line-height: 1\.3; \}/);
});

test('ORD-0027 A: the contact address as plain text with a Copy email button, on every page', () => {
  for (const [p] of LANGS) {
    const html = read(p);
    assert.equal((html.match(/href="mailto:hello@analuciaaos\.com\?subject=30-minute%20diagnostic"/g) ?? []).length, 5, `${p}: the four diagnostic buttons stay, and the onboarding card of the pricing view uses the same one (ORD-0032 C)`);
    const rows = [...html.matchAll(/<span class="mailcopy"><span class="addr" id="(addr-\w+)">hello@analuciaaos\.com<\/span> <button type="button" class="copy" data-copy-email="(addr-\w+)" hidden>[^<]+<\/button><\/span>/g)];
    assert.deepEqual(rows.map((m) => [m[1], m[2]]), [['addr-top', 'addr-top'], ['addr-start', 'addr-start']], p);
    assert.match(html, /<p class="sr-only" id="copy-status" aria-live="polite"><\/p>/, p);
    const s = scriptOf(html);
    assert.match(s, /\$\('\[data-copy-email\]'\)[\s\S]*navigator\.clipboard\.writeText\(addr\.textContent\)[\s\S]*select\(addr\)/, p);
    assert.match(s, /document\.getElementById\('copy-status'\)\.textContent = '[^']+' \+ addr\.textContent;\n {8}setTimeout\(function \(\) \{ b\.textContent = '[^']+'; \}, 2000\);/, p);
  }
  assert.match(index(), />Copy email<\/button>/);
  assert.match(scriptOf(index()), /b\.textContent = 'Copy email'; \}, 2000\)/);
});

test('ORD-0027 B: commands never break inside a word, and the event strip shows numbered sample events', () => {
  const css = read('style.css');
  assert.match(css, /\.start code \{[^}]*white-space: pre; overflow-x: auto; \}/);
  assert.doesNotMatch(css, /break-all/);
  assert.match(css, /\.cmd code \{ margin-top: 0; flex: 1; min-width: 0; \}/);
  assert.match(css, /\.before code \{ white-space: nowrap; \}/);
  assert.match(css, /\.chain ol \{ counter-reset: ev 40; \}\n\.chain li \{ counter-increment: ev; \}\n\.chain li::after \{ content: " " counter\(ev\); \}/);
  for (const [p] of LANGS) {
    assert.match(read(p), /<div class="chain" aria-label="[^"]+">\s*<ol>(?:<li>[^<]+<\/li>){4}<\/ol>/, `${p}: four sample events, still labelled as an example`);
  }
});

test('ORD-0027 D: WhatsApp is wired but switched off: one empty number, the rule per page, nothing rendered', () => {
  for (const [p, lang] of LANGS) {
    const s = scriptOf(read(p));
    assert.equal((s.match(/var WHATSAPP_NUMBER = '';/g) ?? []).length, 1, `${p}: one place, empty`);
    assert.match(s, new RegExp(`var WA_ALWAYS = ${lang === 'es' || lang === 'pt-BR'};`), p);
    assert.match(s, /if \(wa && \(WA_ALWAYS \|\| tz === 'Asia\/Kolkata' \|\| tz === 'Asia\/Calcutta'\)\)/, p);
    assert.match(s, /Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone/, p);
    assert.match(s, /a\.href = 'https:\/\/wa\.me\/' \+ wa \+ '\?text=' \+ encodeURIComponent\(WA_TEXT\);/, p);
    assert.doesNotMatch(read(p).replace(/<script>[\s\S]*?<\/script>/, ''), /whatsapp|wa\.me/i, `${p}: nothing about WhatsApp outside the script`);
  }
  assert.match(read('privacy.html'), /If you choose to talk to us on WhatsApp, that conversation is handled by WhatsApp under its own terms\./);
  const deploy = readFileSync(join(ROOT, 'docs', 'SITE-DEPLOY.md'), 'utf8');
  assert.match(deploy, /WHATSAPP_NUMBER/);
  for (const f of ['es/index.html', 'pt/index.html', 'hi/index.html']) assert.ok(deploy.includes(f), f);
});

// ---------- ORD-0032 ----------

// Per page: the words of each language for the checks below (the page text is written in the page's own language).
const WORDS = {
  'index.html': { four: 'Four steps.', three: /Three steps/, hour: /hour/i, plugin: /plugin/, lang: /language/i, sub: /subfolder/ },
  'es/index.html': { four: 'Cuatro pasos.', three: /Tres pasos/, hour: /hora/i, plugin: /plugin/, lang: /idioma/i, sub: /subcarpeta/ },
  'pt/index.html': { four: 'Quatro passos.', three: /Três passos/, hour: /hora/i, plugin: /plugin/, lang: /idioma/i, sub: /subpasta/ },
  'hi/index.html': { four: 'चार चरण।', three: /तीन चरण/, hour: /घंट/, plugin: /प्लगइन/, lang: /भाषा/, sub: /सब-फ़ोल्डर/ },
};
const startSteps = (html) => [...(/<ol class="start">([\s\S]*?)<\/ol>/.exec(html)?.[1] ?? '').matchAll(/<li><div>([\s\S]*?)<\/div><\/li>/g)].map((m) => m[1]);
const hint = (step) => /<span class="hint">([^<]*)<\/span>/.exec(step)?.[1] ?? '';

test('ORD-0032 A.1: the third step tells the truth about the first message and the folder', () => {
  for (const [p] of LANGS) {
    const html = read(p);
    const w = WORDS[p];
    const third = startSteps(html)[2] ?? '';
    const h = hint(third);
    assert.match(h, /aos init/, `${p}: the first message of a folder not set up gives the aos init command`);
    assert.match(h, w.sub, `${p}: not in a subfolder`);
    assert.match(h, /“Status:”/, `${p}: says where "Status:" appears`);
    assert.ok(h.indexOf('aos init') < h.indexOf('“Status:”'), `${p}: the folder that is not set up comes first; "Status:" only for a folder already set up`);
  }
  assert.doesNotMatch(index(), /Nothing to type/);
});

test('ORD-0032 A.2 and item 9: four steps, the fourth is the setup (15 questions, 3 blocks, about 5 minutes, CONFIRM, the language first)', () => {
  for (const [p] of LANGS) {
    const html = read(p);
    const w = WORDS[p];
    const steps = startSteps(html);
    assert.equal(steps.length, 4, `${p}: add, install, open in that same folder, answer the setup`);
    assert.match(steps[0], /<code id="c-add">/, p);
    assert.match(steps[1], /<code id="c-install">/, p);
    const h = hint(steps[3]);
    for (const re of [/aos init/, /\b15\b/, /\b3\b/, /\b5\b/, /CONFIRM/, w.lang]) assert.match(h, re, `${p}: ${re}`);
    assert.match(/<h2 id="h-start">([\s\S]*?)<\/h2>/.exec(html)[1], new RegExp(`^${w.four}`), `${p}: the heading counts four`);
    assert.doesNotMatch(prose(html), w.three, `${p}: no "three steps" left`);
  }
});

test('ORD-0032 A.4: the guard claim holds only with the plugin active in the project folder', () => {
  for (const [p] of LANGS) {
    const ex = /<p class="example" id="ex-3">([^<]+)<\/p>/.exec(read(p))[1];
    assert.match(ex, WORDS[p].plugin, p);
  }
});

test('ORD-0032 A.5: the recovery card gives no duration', () => {
  for (const [p] of LANGS) {
    const cards = /<ul class="cards small">([\s\S]*?)<\/ul>/.exec(read(p))[1].replace(/<[^>]+>/g, ' ');
    assert.doesNotMatch(cards, WORDS[p].hour, p);
    assert.doesNotMatch(cards, /\d/, p);
  }
});

test('ORD-0032 A.6: the footer shows the product name next to the year, from the one variable', () => {
  for (const [p] of LANGS) assert.match(read(p), /<footer>[\s\S]*<span>© \d{4} <span class="name"><\/span><\/span>[\s\S]*<\/footer>/, p);
  assert.match(read('style.css'), /\.name::before \{ content: var\(--product-name\); \}/);
});

test('ORD-0032 C: the pricing view, after Get started, with three cards, two lines, no figure, no price and no plan beyond the three', () => {
  for (const [p] of LANGS) {
    const html = read(p);
    const views = [...html.matchAll(/<section class="view[^"]*" id="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(views.slice(-2), ['start', 'pricing'], `${p}: after Get started, last before the footer`);
    const sec = /<section class="view" id="pricing"[\s\S]*?<\/section>/.exec(html)[0];
    const cards = [...sec.matchAll(/<li class="card">([\s\S]*?)<\/li>/g)].map((m) => m[1]);
    assert.equal(cards.length, 3, `${p}: three cards`);
    assert.match(sec, /<ul class="cards pricing">/, p);
    assert.match(cards[0], /<a class="btn" href="#start">/, `${p}: Core points to the install steps`);
    assert.match(cards[1], /<a class="btn o" href="mailto:hello@analuciaaos\.com\?subject=[A-Za-z0-9%-]+">/, `${p}: Online services is an email notice`);
    const diag = /<a class="btn btn-sm cta-top" href="([^"]+)">([^<]+)<\/a>/.exec(html);
    assert.match(cards[2], new RegExp(`<a class="btn o" href="${diag[1].replace(/[.?]/g, '\\$&')}">${diag[2]}</a>`), `${p}: Onboarding uses the existing contact button, same target and text`);
    const words = cards.map((c) => c.replace(/<a [\s\S]*?<\/a>/, ' ').replace(/<[^>]+>/g, ' ')).join(' ');
    assert.doesNotMatch(words, /\d/, `${p}: no figure on the cards (the button text is the existing one)`);
    assert.doesNotMatch(sec, /[$€£₹]|\b(?:usd|eur|inr|brl)\b|recommend|recomend|✓|अनुशंस/i, `${p}: no price, currency or "recommended" mark`);
    assert.equal((sec.match(/<h3>/g) ?? []).length, 3, `${p}: no plan beyond the three cards`);
    assert.match(sec, /<\/ul>\s*<p class="note"><span>[^<]+<\/span><span>[^<]+<\/span><\/p>/, `${p}: the two lines below the cards`);
    const nav = /<nav aria-label="[^"]+">([\s\S]*?)<\/nav>/.exec(html)[1];
    assert.deepEqual([...nav.matchAll(/<a href="#([^"]+)">/g)].map((m) => m[1]), ['how', 'see', 'start', 'pricing', 'talk'], `${p}: one nav link to the pricing view`);
    for (const re of FORBIDDEN) assert.equal(new RegExp(re.source, 'i').exec(prose(sec)), null, `${p}: forbidden ${re}`);
  }
});

// Blocks per part of a page (header, each view, footer, phone bar): the four pages must carry the same blocks.
const BLOCKS = ['h1', 'h2', 'h3', 'p', 'li', 'button', 'a', 'code', 'tr', 'td', 'th', 'table', 'ul', 'ol', 'figure', 'aside', 'strong', 'em'];
const blocksOf = (html) => {
  const body = html.replace(/<script>[\s\S]*?<\/script>/, '').replace(/<p class="wrap transnote"[\s\S]*?<\/p>/, '');
  const parts = { header: /<header[\s\S]*?<\/header>/.exec(body)?.[0] ?? '', footer: /<footer[\s\S]*?<\/footer>/.exec(body)?.[0] ?? '', bar: /<div class="cta-bar">[\s\S]*?<\/div>/.exec(body)?.[0] ?? '' };
  for (const m of body.matchAll(/<section class="view[^"]*" id="([^"]+)"[\s\S]*?<\/section>/g)) parts[m[1]] = m[0];
  return Object.fromEntries(Object.entries(parts).map(([k, s]) => [k, BLOCKS.map((t) => `${t}:${(s.match(new RegExp(`<${t}[\\s>]`, 'g')) ?? []).length}`).join(' ')]));
};

test('ORD-0032 D: the four pages carry the same blocks in every part (headings, paragraphs, list items, buttons, links, tables)', () => {
  const en = blocksOf(index());
  for (const [p] of LANGS) assert.deepEqual(blocksOf(read(p)), en, `${p}: a block that exists in one language and not in another`);
});
