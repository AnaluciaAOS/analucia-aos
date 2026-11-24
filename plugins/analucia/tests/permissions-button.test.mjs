// ORD-0046 part 4 (PERMISOS, decision 2: A): `aos permissions apply` is owner-only (E_OWNER_TTY without a terminal),
// shows in plain words what will change in the permission files, asks for a typed word, and writes both files
// (versioned permissions-only, and local) with the same function as `aos permissions write`. Nothing is written
// without the word or without a terminal.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LAUNCHERS } from '../lib/launchers.mjs';
import { catalog } from '../lib/onboarding.mjs';
import { APPLY_WORD, permissionsApply, permissionsPlan } from '../lib/permissions.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env };
delete env.CLAUDE_PROJECT_DIR; delete env.CLAUDECODE; delete env.CLAUDE_CODE_SESSION_ID;
const t = catalog('es');

function project() {
  const root = mkdtempSync(join(tmpdir(), 'aos-permbtn-'));
  mkdirSync(join(root, '.analucia'), { recursive: true });
  writeFileSync(join(root, '.analucia', 'project.json'), JSON.stringify({ wip_limit: 1, locale: 'es' }));
  writeFileSync(join(root, '.analucia', 'events.jsonl'), '');
  mkdirSync(join(root, '.claude'));
  writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(git push *)', 'Bash(make *)'], deny: [], ask: ['Bash(git push *)'] } }));
  return root;
}
const run = (root, typed) => {
  const out = [];
  return permissionsApply(root, { isTTY: true, ask: async (q) => { out.push(q); return typed; }, out: (l) => out.push(l), t }).then((r) => ({ r, out }));
};

test('without a terminal it is refused with E_OWNER_TTY and nothing is written, even with the word piped in', () => {
  const root = project();
  const before = readFileSync(join(root, '.claude', 'settings.json'), 'utf8');
  const r = spawnSync(process.execPath, [AOS, 'permissions', 'apply', '--root', root], { encoding: 'utf8', env, input: `${APPLY_WORD}\n` });
  assert.notEqual(r.status, 0);
  assert.match(`${r.stdout}${r.stderr}`, /E_OWNER_TTY/);
  assert.equal(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'), before);
  assert.ok(!existsSync(join(root, '.claude', 'settings.local.json')));
  return assert.rejects(() => permissionsApply(root, { isTTY: false, ask: async () => APPLY_WORD, out: () => {}, t }), { code: 'E_OWNER_TTY' });
});

test('it shows the counts and the rules added and removed, in tú, before asking', async () => {
  const root = project();
  const plan = permissionsPlan(root);
  assert.deepEqual(plan.map((f) => f.path), ['.claude/settings.json', '.claude/settings.local.json']);
  assert.ok(plan[0].removed.ask.includes('Bash(git push *)') && plan[0].removed.allow.includes('Bash(git push *)'), 'the old rules go');
  assert.ok(plan[0].added.allow.includes('Bash') && plan[0].counts.ask === 0);
  const { out } = await run(root, '');
  const text = out.join('\n');
  assert.match(text, /^Vas a cambiar los permisos de este proyecto/m);
  assert.match(text, /\.claude\/settings\.json — permitir \d+ · negar \d+ · preguntar 0/);
  assert.match(text, /Se agregan \d+ regla\(s\)/);
  assert.match(text, /Se quitan 2 regla\(s\)/);
  assert.match(out.at(-2), /Escribe APLICAR para escribir estos permisos, o pulsa Enter para no cambiar nada: /);
  assert.doesNotMatch(text, /\busted\b|\bpulse\b|\bescriba\b/i);
});

test('nothing is written without the typed word; with it both files are written', async () => {
  const root = project();
  const before = readFileSync(join(root, '.claude', 'settings.json'), 'utf8');
  for (const wrong of ['', 'si', 'aplicar', 'APLICAR YA']) {
    const { r, out } = await run(root, wrong);
    assert.equal(r.cancelled, true, JSON.stringify(wrong));
    assert.deepEqual(r.written, []);
    assert.ok(out.includes('No se escribió nada.'));
  }
  assert.equal(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'), before);
  assert.ok(!existsSync(join(root, '.claude', 'settings.local.json')));
  const { r } = await run(root, APPLY_WORD);
  assert.deepEqual(r.written, ['.claude/settings.json', '.claude/settings.local.json']);
  const versioned = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(versioned.permissions.ask, []);
  assert.ok(versioned.permissions.allow.includes('Bash(make *)'), 'a foreign rule is kept');
  assert.ok(!('enabledPlugins' in versioned), 'permissions only');
  assert.ok(existsSync(join(root, '.claude', 'settings.local.json')));
});

test('a second press finds nothing to change', async () => {
  const root = project();
  await run(root, APPLY_WORD);
  const { r, out } = await run(root, APPLY_WORD);
  assert.deepEqual(r.written, []);
  assert.deepEqual(out, ['Los permisos de este proyecto ya están al día: no hay nada que cambiar.']);
});

test('the launcher PERMISOS runs aos permissions apply', () => {
  assert.deepEqual(LAUNCHERS.find((l) => l.name === 'PERMISOS')?.args, ['permissions', 'apply']);
});
