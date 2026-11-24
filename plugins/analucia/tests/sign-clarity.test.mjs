// ORD-0046 part 7 (OBS-194, OBS-195, OBS-199): FIRMAR that the owner understands. The first line is the project's name;
// the orders he came for come first, each with its own documents right before its checks; a document of a closed order
// changed by the current order is shown under the current order; every question says in tú what the answer does, with
// the Spanish words (APROBAR, COMENTAR, RECHAZAR, CERRAR, UNIR, COLOCAR) next to the English ones; a comment without a
// useful note reopens nothing; one launcher file per name on Windows.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LAUNCHER_NAMES, installLaunchers } from '../lib/launchers.mjs';
import { close, verify } from '../lib/lifecycle.mjs';
import { hashLF } from '../lib/lock.mjs';
import { appendEvent, logPath, readLog } from '../lib/log.mjs';
import { COMMENT_MIN_LETTERS, decideReview, requestReview, reviewState, usefulComment } from '../lib/review.mjs';
import { sign } from '../lib/sign.mjs';
import { replay } from '../lib/state.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
delete env.CLAUDE_PROJECT_DIR;
delete env.CLAUDE_CODE_SESSION_ID;
const aos = (root, args) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input: '', env });

const order = (id) => ['---', `id: ${id}`, `title: Orden ${id}`, 'kind: fix', 'created: 2026-11-14', 'budget_max_minutes: 30', 'budget_max_attempts: 3', 'risk: low', 'cost_effect: none', '---', '', '## Acceptance criteria', '', '- [ ] x', ''].join('\n');
const doc = (title, body = 'Un texto.') => `# ${title}\n\n${body}\n\n## Decisiones\n\nNinguna\n`;
const DECISION = 'Aprobado por el dueño: prueba';

// A project in Spanish with the given orders already admitted (queued). `code` null: the folder name is the name.
function project(ids, { code = 'DEMO' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aos-clarity-'));
  const a = join(root, '.analucia');
  for (const d of ['orders', 'verify', 'evidence', 'drafts']) mkdirSync(join(a, d), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(a, 'project.json'), `${JSON.stringify({ wip_limit: 3, locale: 'es', ...(code ? { project_code: code } : {}) })}\n`);
  writeFileSync(logPath(root), '');
  const files = {};
  for (const id of ids) {
    writeFileSync(join(a, 'orders', `${id}.md`), order(id));
    writeFileSync(join(a, 'verify', `${id}.json`), JSON.stringify({ order: id, checks: [{ name: 'la prueba', run: 'exit 0', expect_exit: 0 }] }));
    for (const rel of [`.analucia/orders/${id}.md`, `.analucia/verify/${id}.json`]) files[rel] = hashLF(readFileSync(join(root, rel)));
    appendEvent(root, { type: 'record.created', actor: 'director', subject: id });
    appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: id, payload: { from: 'draft', to: 'ready' } });
    appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: id, payload: { from: 'ready', to: 'queued' } });
  }
  writeFileSync(join(a, 'director.lock'), JSON.stringify({ files }));
  return root;
}
const report = (root, id) => {
  mkdirSync(join(root, '.analucia', 'evidence', id), { recursive: true });
  writeFileSync(join(root, '.analucia', 'evidence', id, 'report.md'), '# r\n\n## Evidencia\n\nx\n\nOUTCOME: done\n');
  return `.analucia/evidence/${id}/report.md`;
};
const start = (root, id) => assert.equal(aos(root, ['run', 'start', id]).status, 0);
const finish = (root, id) => assert.equal(aos(root, ['run', 'finish', id, '--outcome', 'done', '--evidence', report(root, id)]).status, 0);
const delivered = (root, id) => { start(root, id); finish(root, id); };
const request = (root, file, id, text) => { writeFileSync(join(root, file), text); return requestReview(root, file, { order: id }); };
const stateOf = (root, id) => replay(readLog(root).events).orders[id]?.state;
const draft = (root, id) => {
  writeFileSync(join(root, '.analucia', 'drafts', `${id}.md`), order(id).replace('---\n\n', `decision: ${DECISION}\n---\n\n`));
  writeFileSync(join(root, '.analucia', 'drafts', `${id}.request.md`), '- a point of the request => the draft'), writeFileSync(join(root, '.analucia', 'drafts', `${id}.json`), JSON.stringify({ order: id, checks: [{ name: 'x', run: 'exit 0', expect_exit: 0 }] }));
};
// The owner at the terminal: answers each question from a script of [pattern, answer] pairs, in order of the questions.
function owner(script, { open } = {}) {
  const lines = [];
  const asked = [];
  const queue = [...script];
  const ask = async (q) => {
    asked.push(q);
    lines.push(`? ${q}`);
    const i = queue.findIndex(([re]) => re.test(q));
    if (i === -1) return '';
    return queue.splice(i, 1)[0][1];
  };
  return { lines, asked, opts: { isTTY: true, push: false, ask, out: (s) => lines.push(s), ...(open ? { open } : {}) } };
}
const at = (lines, re) => lines.findIndex((l) => re.test(l));

test('the first line is the project\'s name: its code, else its folder name', async () => {
  const root = project(['DEMO-0001']);
  delivered(root, 'DEMO-0001');
  const o = owner([]);
  await assert.rejects(sign(root, o.opts), (x) => x.code === 'E_NOT_CONFIRMED');
  assert.equal(o.lines[0], 'Proyecto: DEMO');
  const bare = project(['ORD-0001'], { code: null });
  const folder = bare.split(/[\\/]/).at(-1);
  const o2 = owner([]);
  await sign(bare, o2.opts);
  assert.equal(o2.lines[0], `Proyecto: ${folder}`);
});

test('the order of the items: drafts, then each order with its own documents right before its checks, then the closed orders\' documents last', async () => {
  const root = project(['DEMO-0001', 'DEMO-0002', 'DEMO-0003']);
  // DEMO-0003: delivered, verified by the tool and closed long ago, with a document nobody decided on.
  delivered(root, 'DEMO-0003');
  request(root, 'docs/old.md', 'DEMO-0003', doc('Documento viejo'));
  verify(root, 'DEMO-0003');
  await close(root, ['DEMO-0003'], { isTTY: true, ask: async () => 'CLOSE' });
  draft(root, 'DEMO-0004');
  delivered(root, 'DEMO-0001');
  request(root, 'docs/uno.md', 'DEMO-0001', doc('Documento uno'));
  delivered(root, 'DEMO-0002');
  request(root, 'docs/dos.md', 'DEMO-0002', doc('Documento dos'));
  const o = owner([[/COLOCAR/, 'COLOCAR'], [/Documento uno/, 'aprobar'], [/Documento dos/, 'APROBAR'], [/CERRAR/, 'cerrar'], [/Documento viejo/, 'aprobar']]);
  const r = await sign(root, o.opts);
  const L = o.lines;
  const idx = {
    project: at(L, /^Proyecto: DEMO$/),
    drafts: at(L, /Órdenes en borrador/),
    uno: at(L, /Documento: Documento uno/),
    check1: at(L, /Comprobando DEMO-0001/),
    dos: at(L, /Documento: Documento dos/),
    check2: at(L, /Comprobando DEMO-0002/),
    closedHeading: at(L, /Documentos de órdenes que ya están cerradas \(1\)/),
    viejo: at(L, /Documento: Documento viejo/),
    confirm: at(L, /^\? Escribe CERRAR/),
  };
  for (const [k, v] of Object.entries(idx)) assert.ok(v >= 0, `${k} is shown: ${L.join('\n')}`);
  assert.deepEqual(Object.entries(idx).sort((a, b) => a[1] - b[1]).map(([k]) => k), ['project', 'drafts', 'uno', 'check1', 'dos', 'check2', 'closedHeading', 'viejo', 'confirm']);
  assert.deepEqual(r.signed.sort(), ['DEMO-0001', 'DEMO-0002']);
  assert.deepEqual(r.placed, ['DEMO-0004']);
});

test('a document of a closed order changed by the current order is shown under the current order, not with the closed one', async () => {
  const root = project(['DEMO-0001', 'DEMO-0002']);
  delivered(root, 'DEMO-0001');
  request(root, 'docs/sitio.md', 'DEMO-0001', doc('Sitio'));
  verify(root, 'DEMO-0001');
  await close(root, ['DEMO-0001'], { isTTY: true, ask: async () => 'CLOSE' });
  // DEMO-0002 changes the document of the closed order and asks for its review under the closed order's ID.
  start(root, 'DEMO-0002');
  request(root, 'docs/sitio.md', 'DEMO-0001', doc('Sitio', 'Otro texto, cambiado por la orden dos.'));
  finish(root, 'DEMO-0002');
  const state = reviewState(root).find((d) => d.path === 'docs/sitio.md');
  assert.equal(state.order, 'DEMO-0001');
  assert.equal(state.shownIn, 'DEMO-0002', 'it follows the order that changed it');
  const o = owner([[/Documento|Sitio/, 'aprobar'], [/CERRAR/, 'cerrar']]);
  await sign(root, o.opts);
  const L = o.lines;
  const group = at(L, /DEMO-0002: 1 documento\(s\) para revisar, antes de sus controles:/);
  assert.ok(group >= 0, L.join('\n'));
  assert.ok(group < at(L, /Comprobando DEMO-0002/), 'before the checks of the current order');
  assert.equal(at(L, /ya están cerradas/), -1, 'nothing left for the closed-orders heading');
  assert.equal(stateOf(root, 'DEMO-0002'), 'closed');
});

test('the questions say what the answer does, in tú, with the Spanish words; the English words keep working', async () => {
  const root = project(['DEMO-0001']);
  delivered(root, 'DEMO-0001');
  request(root, 'docs/diseno.md', 'DEMO-0001', doc('Diseño del orquestador'));
  const o = owner([[/APROBAR/, 'APROBAR'], [/CERRAR/, 'no']]);
  await assert.rejects(sign(root, o.opts), (x) => x.code === 'E_NOT_CONFIRMED');
  const q = o.asked;
  assert.equal(q[0], 'Escribe APROBAR para aprobar Diseño del orquestador (DEMO-0001), COMENTAR y tu nota para devolver DEMO-0001 a trabajo, RECHAZAR para rechazarlo, o ABRIR para verlo (Enter = decidir después): ');
  assert.equal(q.at(-1), 'Escribe CERRAR para firmar y cerrar DEMO-0001: ');
  for (const text of q) assert.doesNotMatch(text, /\busted\b|\bsu\b|\bsus\b|\bfirme\b|\bescriba\b/i, text);
  // The English words still work (a second project, answered in English words).
  const en = project(['DEMO-0001']);
  delivered(en, 'DEMO-0001');
  request(en, 'docs/diseno.md', 'DEMO-0001', doc('Diseño'));
  const o2 = owner([[/APROBAR|approve/, 'approve'], [/CERRAR|CLOSE/, 'CLOSE']]);
  const r = await sign(en, o2.opts);
  assert.deepEqual(r.signed, ['DEMO-0001']);
  // UNIR and COLOCAR: the drafts and the merge have their own words (the merge is offered after a signature on a branch).
  const place = project([]);
  draft(place, 'DEMO-0009');
  const o3 = owner([[/COLOCAR/, 'colocar']]);
  const placed = await sign(place, o3.opts);
  assert.deepEqual(placed.placed, ['DEMO-0009']);
  assert.match(o3.asked[0], /^Escribe COLOCAR para colocar DEMO-0009 y que el ejecutor pueda empezar/);
  const none = project([]);
  draft(none, 'DEMO-0009');
  const o4 = owner([[/COLOCAR/, 'si']]);
  assert.deepEqual((await sign(none, o4.opts)).placed, []);
});

test('a comment without a useful note does not reopen the order: empty, only the word, or under 10 letters; nothing is recorded', async () => {
  assert.equal(COMMENT_MIN_LETTERS, 10);
  for (const bad of ['', '   ', 'comment', 'Comentar', 'comentario.', 'corto', 'no sirve']) assert.equal(usefulComment(bad), false, JSON.stringify(bad));
  for (const good of ['Falta el paso de pruebas', 'cambia el título del documento']) assert.equal(usefulComment(good), true, good);
  const root = project(['DEMO-0001']);
  delivered(root, 'DEMO-0001');
  request(root, 'docs/plan.md', 'DEMO-0001', doc('Plan'));
  assert.throws(() => decideReview(root, 'docs/plan.md', { decision: 'comment', note: 'comment' }), (x) => x.code === 'E_REVIEW_DECISION');
  assert.throws(() => decideReview(root, 'docs/plan.md', { decision: 'comment', note: '' }), (x) => x.code === 'E_REVIEW_DECISION');
  const before = readLog(root).events.length;
  // At the terminal: the word alone, then the word again as the note, then a short note, then approve.
  const o = owner([[/APROBAR/, 'comentar'], [/comentario/i, 'comentar'], [/APROBAR/, 'comentar corto'], [/APROBAR/, 'aprobar'], [/CERRAR/, 'cerrar']]);
  const r = await sign(root, o.opts);
  const shown = o.lines.join('\n');
  assert.equal((shown.match(/Un comentario necesita tu nota \(al menos 10 letras\), no solo la palabra\. Escribe tu nota después de COMENTAR, o escribe APROBAR para aprobar\./g) ?? []).length, 2, shown);
  assert.equal(readLog(root).events.filter((e) => e.type === 'review.decision' && e.payload.decision === 'comment').length, 0, 'no comment was recorded');
  assert.equal(stateOf(root, 'DEMO-0001'), 'closed', 'the order was never reopened: it was approved and closed');
  assert.deepEqual(r.signed, ['DEMO-0001']);
  assert.ok(readLog(root).events.length > before);
  // A real comment, with the note on the same line, sends the order back to work.
  const back = project(['DEMO-0001']);
  delivered(back, 'DEMO-0001');
  request(back, 'docs/plan.md', 'DEMO-0001', doc('Plan'));
  const o2 = owner([[/APROBAR/, 'COMENTAR Falta el paso de pruebas']]);
  await sign(back, o2.opts);
  const decision = readLog(back).events.find((e) => e.type === 'review.decision');
  assert.equal(decision.payload.decision, 'comment');
  assert.equal(decision.payload.note, 'Falta el paso de pruebas');
  assert.equal(stateOf(back, 'DEMO-0001'), 'active', 'sent back to work');
});

test('on Windows the launchers are the .cmd files only, one per name; elsewhere the .sh files only', () => {
  const win = mkdtempSync(join(tmpdir(), 'aos-clarity-w-'));
  const written = installLaunchers(win, { platform: 'win32', locale: 'es' });
  assert.equal(written.length, LAUNCHER_NAMES.length);
  assert.deepEqual(readdirSync(win).sort(), LAUNCHER_NAMES.map((n) => `${n}.cmd`).sort());
  assert.ok(existsSync(join(win, 'FIRMAR.cmd')) && !existsSync(join(win, 'FIRMAR.sh')), 'one FIRMAR, not two');
  const posix = mkdtempSync(join(tmpdir(), 'aos-clarity-p-'));
  installLaunchers(posix, { platform: 'linux', locale: 'es' });
  assert.deepEqual(readdirSync(posix).sort(), LAUNCHER_NAMES.map((n) => `${n}.sh`).sort());
  // The command itself writes this system's own files.
  const here = mkdtempSync(join(tmpdir(), 'aos-clarity-h-'));
  assert.equal(aos(here, ['launchers', 'install']).status, 0);
  assert.deepEqual(readdirSync(here).sort(), LAUNCHER_NAMES.map((n) => `${n}.${process.platform === 'win32' ? 'cmd' : 'sh'}`).sort());
});
