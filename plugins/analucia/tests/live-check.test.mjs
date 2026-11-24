// ORD-0047 part 1 (OBS-201): `aos live check` reads the published page; a placeholder in place of data fails.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PLACEHOLDERS, placeholdersIn, toNumber, valuesAfter, visibleText } from '../lib/live-check.mjs';
import { listDrafts } from '../lib/drafts.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const PAGES = {
  '/real': '<html><body><h1>Ventas por día</h1><script>var x="no disponible"</script><p>Total: 1,250 pedidos</p><p>Base n=300 clientes</p></body></html>',
  '/placeholder': '<html><body><h1>Ventas por día</h1><div class="card">Fuente no disponible</div></body></html>',
  '/hindi': '<html><body><p>डेटा उपलब्ध नहीं</p></body></html>',
};

async function withServer(fn) {
  const server = createServer((req, res) => {
    const page = PAGES[req.url];
    res.writeHead(page ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page ?? 'not found');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}
const live = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [AOS, 'live', 'check', ...args], { encoding: 'utf8' });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  p.on('close', (code) => resolve({ code, out }));
});

test('real data passes; the script text of the page is not visible text', async () => {
  await withServer(async (base) => {
    const r = await live([`${base}/real`, '--expect', 'ventas por día']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /live check: ok/);
  });
});

test('a "not available" placeholder fails, with the flag it passes', async () => {
  await withServer(async (base) => {
    const bad = await live([`${base}/placeholder`, '--expect', 'Ventas por día']);
    assert.equal(bad.code, 1);
    assert.match(bad.out, /placeholder/);
    assert.match(bad.out, /--placeholder-ok/);
    const ok = await live([`${base}/placeholder`, '--expect', 'Ventas por día', '--placeholder-ok']);
    assert.equal(ok.code, 0, ok.out);
    const hindi = await live([`${base}/hindi`, '--expect', 'डेटा']);
    assert.equal(hindi.code, 1);
  });
});

test('the expected text, a pattern, a page that does not answer', async () => {
  await withServer(async (base) => {
    assert.equal((await live([`${base}/real`, '--expect', 'texto que no está'])).code, 1);
    assert.equal((await live([`${base}/real`, '--expect', '/pedidos?/i'])).code, 0);
    const gone = await live([`${base}/missing`, '--expect', 'x']);
    assert.equal(gone.code, 1);
    assert.match(gone.out, /answered 404/);
  });
});

test('total and base: found and equal; not equal; not found', async () => {
  await withServer(async (base) => {
    assert.equal((await live([`${base}/real`, '--total', '1250', '--base', '300'])).code, 0);
    const wrong = await live([`${base}/real`, '--total', '1300']);
    assert.equal(wrong.code, 1);
    assert.match(wrong.out, /page shows 1250/);
    const wrongBase = await live([`${base}/real`, '--base', '12']);
    assert.equal(wrongBase.code, 1);
    // a page with no total at all
    const none = await live([`${base}/hindi`, '--total', '5', '--placeholder-ok']);
    assert.equal(none.code, 1);
    assert.match(none.out, /no total is shown/);
  });
});

test('the helpers: placeholders in five locales, numbers, labels', () => {
  for (const phrase of ['Not available', 'Fuente no disponible', 'Fonte não disponível', '暂无数据', 'डेटा उपलब्ध नहीं']) assert.ok(placeholdersIn(phrase).length, phrase);
  assert.deepEqual(placeholdersIn('Ventas 1250'), []);
  assert.ok(PLACEHOLDERS.length >= 25);
  assert.equal(toNumber('1,250'), 1250);
  assert.equal(toNumber('1.250'), 1250);
  assert.equal(toNumber('12,5'), 12.5);
  assert.equal(toNumber('abc'), null);
  assert.deepEqual(valuesAfter('Total: 12 y total 40', ['total']), [12, 40]);
  assert.equal(visibleText('<p>a&nbsp;&amp;<b>b</b></p><style>x{}</style>'), 'a & b');
});

test('aos drafts refuses a draft with promises whose verify file has no live check per promise', () => {
  const root = mkdtempSync(join(tmpdir(), 'aos-live-'));
  mkdirSync(join(root, '.analucia', 'drafts'), { recursive: true });
  writeFileSync(join(root, '.analucia', 'project.json'), '{"wip_limit":1,"locale":"en"}\n');
  writeFileSync(join(root, '.analucia', 'events.jsonl'), '');
  const order = (promises) => ['---', 'id: ORD-0001', 'title: t', 'kind: fix', 'created: 2026-11-21', 'budget_max_minutes: 30', 'budget_max_attempts: 2', 'risk: low', 'cost_effect: none', promises, '---', '', '## Acceptance criteria', '', '- [ ] x', ''].join('\n');
  const verify = (runs) => `${JSON.stringify({ order: 'ORD-0001', checks: runs.map((run, i) => ({ name: `c${i}`, run, expect_exit: 0 })) })}\n`;
  const put = (md, json) => { writeFileSync(join(root, '.analucia', 'drafts', 'ORD-0001.md'), md); writeFileSync(join(root, '.analucia', 'drafts', 'ORD-0001.request.md'), '- a point of the request => the draft'), writeFileSync(join(root, '.analucia', 'drafts', 'ORD-0001.json'), json); };
  put(order('promises: [ventas por día en el panel, el motor de precios]'), verify(['aos live check https://x.example/a --expect ventas']));
  const bad = listDrafts(root)[0];
  assert.match(bad.problems.join('\n'), /promises 2 thing\(s\).*runs "aos live check" 1 time/);
  put(order('promises: [ventas por día en el panel, el motor de precios]'), verify(['node aos.mjs live check https://x.example/a --expect ventas', 'node aos.mjs live check https://x.example/b --expect precio']));
  assert.doesNotMatch(listDrafts(root)[0].problems.join('\n'), /live check/);
  put(order('promises: []'), verify(['exit 0']));
  assert.match(listDrafts(root)[0].problems.join('\n'), /E_FIELD_TYPE.*promises/);
});
