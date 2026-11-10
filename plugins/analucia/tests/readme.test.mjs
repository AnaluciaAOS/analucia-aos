// ORD-0036 A: the root README names only paths a public reader can open, and says that `aos init` comes first.
// A "path" here is the target of a relative Markdown link, or a word inside inline code that contains "/" and is
// not a pattern (NNNN, <…>, *, …), a slash command or an address. Fenced blocks hold commands and are left out.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const { parseManifest, MANIFEST } = await import(pathToFileURL(join(ROOT, 'scripts', 'build-public-tree.mjs')).href);
const readme = () => readFileSync(join(ROOT, 'README.md'), 'utf8').replace(/\r\n/g, '\n');
const manifest = () => parseManifest(readFileSync(join(ROOT, MANIFEST), 'utf8'));

export function readmePaths(text) {
  const body = text.replace(/^```[\s\S]*?^```$/gm, (block) => block.replace(/[^\n]/g, '')); // line numbers stay true
  const found = new Map(); // path -> first line number
  const add = (p, line) => { if (!found.has(p)) found.set(p, line); };
  body.split('\n').forEach((raw, i) => {
    for (const [, target] of raw.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
      add(target.split('#')[0], i + 1);
    }
    for (const [, code] of raw.matchAll(/`([^`]+)`/g)) {
      for (const word of code.split(/\s+/)) {
        const w = word.replace(/[.,;:)]+$/, '');
        if (!w.includes('/') || w.startsWith('/') || /NNNN|[<>*…{}@]|^[a-z][a-z0-9+.-]*:\/\//i.test(w)) continue;
        add(w, i + 1);
      }
    }
  });
  return [...found].map(([path, line]) => ({ path, line }));
}

// Is a path in the public tree, by the release manifest alone? A folder is public when a public file lives under it.
function isPublic(p, m) {
  const priv = (x) => m.private.some((e) => e.re.test(x));
  const pub = (x) => m.public.some((e) => e.re.test(x));
  if (!p.endsWith('/')) return pub(p) && !priv(p);
  return m.public.some((e) => e.entry.startsWith(p)) || (pub(`${p}_`) && !priv(`${p}_`));
}

test('ORD-0036 A.1: README.md names no path that the release manifest keeps out of the public tree', () => {
  const m = manifest();
  const paths = readmePaths(readme());
  assert.ok(paths.length >= 10, `the README names paths (${paths.length} found)`);
  const absent = paths.filter(({ path }) => !isPublic(path, m)).map(({ path, line }) => `README.md:${line} ${path}`);
  assert.deepEqual(absent, [], `${absent.length} path(s) named by the README are absent from the public tree`);
});

test('ORD-0036 A.3: every relative path or link in README.md exists in this checkout', (t) => {
  const m = manifest();
  const missing = readmePaths(readme()).filter(({ path }) => !existsSync(join(ROOT, path)));
  const priv = missing.filter(({ path }) => !isPublic(path, m));
  const broken = missing.filter(({ path }) => isPublic(path, m)).map(({ path, line }) => `README.md:${line} ${path}`);
  assert.deepEqual(broken, [], 'a public path named by the README is missing from this checkout');
  if (priv.length) t.skip(`private path(s) absent from this checkout: ${priv.map((x) => x.path).join(', ')}`);
});

test('ORD-0036 A.2: "A first session" says that aos init comes first and that FAIL / E_FILE_MISSING before it is expected', () => {
  const section = /^## A first session\n([\s\S]*?)^## /m.exec(readme())[1];
  const sentence = section.split(/(?<=[.!?])\s+/).find((s) => s.includes('E_FILE_MISSING'));
  assert.ok(sentence, 'one sentence names E_FILE_MISSING');
  for (const t of ['`aos init`', '`aos init --check`', '`aos validate`', 'FAIL', 'remote', 'expected']) assert.ok(sentence.includes(t), t);
  assert.match(sentence, /comes first/);
});
