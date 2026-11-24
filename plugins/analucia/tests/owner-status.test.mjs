// ORD-0046 part 2: `aos status --owner` and the launcher ESTADO. In at most six plain lines, in tú: which order runs,
// in which part and run it is, whether it waits for something of the owner (and the button), what comes next when
// nothing runs. It reads and changes nothing.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LAUNCHERS, installLaunchers, launcherFile } from '../lib/launchers.mjs';
import { hashLF } from '../lib/lock.mjs';
import { appendEvent, logPath } from '../lib/log.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
delete env.CLAUDE_PROJECT_DIR;
const ORDER = (id) => ['---', `id: ${id}`, `title: Titulo de ${id}`, 'kind: fix', 'created: 2026-11-14', 'budget_max_minutes: 30', 'budget_max_attempts: 2', 'risk: low', 'cost_effect: none', '---', '', '## Part 1 — A', '', '## Part 2 — B', '', '## Part 3 — C', '', '## Acceptance criteria', '', '- [ ] x', ''].join('\n');
const VERIFY = (id) => JSON.stringify({ order: id, checks: [{ name: 'the check', run: 'exit 0', expect_exit: 0 }] });

function project(ids) {
  const root = mkdtempSync(join(tmpdir(), 'aos-ostatus-'));
  const a = join(root, '.analucia');
  for (const d of ['orders', 'verify', 'evidence', 'drafts']) mkdirSync(join(a, d), { recursive: true });
  writeFileSync(join(a, 'project.json'), `${JSON.stringify({ wip_limit: 3, locale: 'es', project_code: 'DEMO' })}\n`);
  writeFileSync(logPath(root), '');
  writeFileSync(join(a, 'evidence', 'report.md'), '# r\n\n## Evidencia\n\nx\n\nOUTCOME: done\n');
  const files = {};
  for (const id of ids) {
    writeFileSync(join(a, 'orders', `${id}.md`), ORDER(id));
    writeFileSync(join(a, 'verify', `${id}.json`), VERIFY(id));
    for (const rel of [`.analucia/orders/${id}.md`, `.analucia/verify/${id}.json`]) files[rel] = hashLF(readFileSync(join(root, rel)));
    appendEvent(root, { type: 'record.created', actor: 'director', subject: id });
    appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: id, payload: { from: 'draft', to: 'ready' } });
    appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: id, payload: { from: 'ready', to: 'queued' } });
  }
  writeFileSync(join(a, 'director.lock'), JSON.stringify({ files }));
  return root;
}
const aos = (root, args) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input: '', env });
const estado = (root) => {
  const r = aos(root, ['status', '--owner']);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trimEnd().split('\n');
  assert.ok(lines.length <= 6, `at most six lines: ${lines.length}`);
  assert.match(lines.at(-1), /^OK: /, 'ends with one closing line');
  return lines;
};
// No formal address in what the owner reads.
const inTu = (text) => assert.doesNotMatch(text, /\busted(es)?\b|\bsu\b|\bsus\b|\bpulse\b|\bfirme\b/i, text);

test('an order running: which order, which run, which part, and nothing waits for the owner', () => {
  const root = project(['DEMO-0001']);
  assert.equal(aos(root, ['run', 'start', 'DEMO-0001']).status, 0);
  const lines = estado(root);
  assert.equal(lines[0], 'Estado de DEMO');
  assert.equal(lines[1], 'Corre DEMO-0001 (Titulo de DEMO-0001): va en la corrida 1 de 2.');
  assert.equal(lines[2], 'Va en la parte 1 de 3.');
  assert.equal(lines[3], 'No espera nada de ti.');
  inTu(lines.join('\n'));
});

test('an order that waits for the owner says what and which button', () => {
  const root = project(['DEMO-0001']);
  aos(root, ['run', 'start', 'DEMO-0001']);
  const f = aos(root, ['run', 'finish', 'DEMO-0001', '--outcome', 'done', '--evidence', '.analucia/evidence/report.md']);
  assert.equal(f.status, 0, f.stderr);
  const lines = estado(root);
  assert.ok(lines.some((l) => l === 'Te espera a ti: firmar DEMO-0001. Pulsa FIRMAR.'), lines.join('\n'));
  inTu(lines.join('\n'));
});

test('nothing running: it says so and what comes next, and the log is untouched', () => {
  const root = project(['DEMO-0001']);
  const before = readFileSync(logPath(root), 'utf8');
  const lines = estado(root);
  assert.equal(lines[1], 'Ahora no corre ninguna orden.');
  assert.equal(lines[2], 'No espera nada de ti.');
  assert.equal(lines[3], 'Sigue: iniciar DEMO-0001; lo hace un agente, no tú.');
  assert.equal(readFileSync(logPath(root), 'utf8'), before, 'it changes nothing');
  const empty = project([]);
  assert.equal(estado(empty)[3], 'No hay nada más en marcha.');
});

test('a halt is said first, in tú', () => {
  const root = project(['DEMO-0001']);
  writeFileSync(join(root, '.analucia', 'HALT'), `${JSON.stringify({ reason: 'x', since: '2026-11-14T09:00:00.000-05:00', by: 'owner' })}\n`);
  const lines = estado(root);
  assert.equal(lines[1], 'El proyecto está detenido. Pulsa REANUDAR para que los agentes sigan trabajando.');
});

test('the launcher ESTADO runs aos status --owner and keeps its window open', () => {
  assert.deepEqual(LAUNCHERS.find((l) => l.name === 'ESTADO')?.args, ['status', '--owner']);
  const root = mkdtempSync(join(tmpdir(), 'aos-ostatus-launch-'));
  installLaunchers(root, { only: ['ESTADO'], locale: 'es' });
  const text = readFileSync(join(root, launcherFile('ESTADO', 'win32')), 'utf8');
  assert.match(text, /status --owner/);
  assert.match(text, /\r\npause\r\n$/);
  assert.match(text, /qué orden corre, en qué parte va y si espera algo de ti/);
});
