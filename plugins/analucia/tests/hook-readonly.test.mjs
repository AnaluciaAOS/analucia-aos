// ORD-0012 item 3: read-only commands are never blocked by the pre-tool-use hook (with or without an open run),
// while every write to a director file, HALT or the lock is still blocked. Item 4: a session start leaves
// .claude/settings.json unchanged.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { appendEvent, logPath } from '../lib/log.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const env = { ...process.env };
delete env.CLAUDE_PROJECT_DIR;
const hook = (root, tool, input, name = 'pre-tool-use') => spawnSync(process.execPath, [AOS, 'hook', name, '--root', root], { encoding: 'utf8', env, input: JSON.stringify({ tool_name: tool, tool_input: input, cwd: root, session_id: 's' }) });

function project({ openRun }) {
  const root = mkdtempSync(join(tmpdir(), 'aos-ro-'));
  for (const d of ['orders', 'verify', 'evidence']) mkdirSync(join(root, '.analucia', d), { recursive: true });
  mkdirSync(join(root, 'core'));
  writeFileSync(join(root, '.analucia', 'project.json'), '{"wip_limit":1}\n');
  writeFileSync(logPath(root), '');
  writeFileSync(join(root, '.analucia', 'orders', 'ORD-0001.md'), '---\nid: ORD-0001\ntitle: t\nkind: fix\ncreated: 2026-10-22\nbudget_max_minutes: 30\nbudget_max_attempts: 2\n---\n\n## Acceptance criteria\n\n- [ ] x\n');
  if (openRun) {
    appendEvent(root, { type: 'record.created', actor: 'director', subject: 'ORD-0001' });
    appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: 'ORD-0001', payload: { from: 'draft', to: 'ready' } });
    appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: 'ORD-0001', payload: { from: 'ready', to: 'queued' } });
    assert.equal(spawnSync(process.execPath, [AOS, 'run', 'start', 'ORD-0001', '--root', root], { encoding: 'utf8', env }).status, 0);
  }
  return root;
}

const SCRATCH = '/tmp/aos-scratch';
// The read-only commands an executor runs, including the shapes that were blocked in batch 5.
export const READ_ONLY = [
  'git log --oneline -5', 'git status --short', 'git diff --stat', 'git show HEAD --stat', 'ls .analucia/orders', 'pwd',
  'cat .analucia/orders/ORD-0001.md', 'head -5 core/NOMENCLATURE.md', 'grep -n kind .analucia/orders/ORD-0001.md',
  'sha256sum .analucia/director.lock core/NOMENCLATURE.md', 'git check-attr eol .analucia/events.jsonl',
  'node plugins/analucia/bin/aos.mjs derive', 'node plugins/analucia/bin/aos.mjs history ORD-0001', 'node plugins/analucia/bin/aos.mjs verify-log',
  'node plugins/analucia/bin/aos.mjs validate 2>&1 | head -5',
  `cat .analucia/orders/ORD-0001.md > ${SCRATCH}/copy.md`,
  `{ echo '$ lock check'; node -e 'console.log(1)' .analucia/director.lock; } > "${SCRATCH}/out.txt" 2>&1`,
  `{ node dry.mjs .analucia/verify/ORD-0009.A.json; } >> ${SCRATCH}/acc.out`,
  `cat > "${SCRATCH}/script.mjs" <<'EOF'\nconst a = ['cat .analucia/orders/ORD-0001.md', 'core/NOMENCLATURE.md'];\nEOF`,
];
// Writes that must stay blocked (no rule protecting director files, HALT or the lock is loosened).
const WRITES = [
  'echo x > .analucia/orders/ORD-0001.md', 'echo x >> core/NOMENCLATURE.md', 'cat a.md > ".analucia/verify/ORD-0001.json"',
  'printf x >| .analucia/director.lock', 'echo x>.analucia/orders/ORD-0002.md', 'touch .analucia/HALT',
  'cat > .analucia/orders/ORD-0003.md <<EOF\nnew text\nEOF', 'rm .analucia/orders/ORD-0001.md', 'cp a.md .analucia/orders/ORD-0001.md',
  'mv core/NOMENCLATURE.md /tmp/x', 'tee .analucia/director.lock < a', "sed -i 's/a/b/' .analucia/orders/ORD-0001.md",
  'git checkout -- .analucia/director.lock', `cat x > ${SCRATCH}/y && rm .analucia/orders/ORD-0001.md`,
  "node -e \"require('fs').writeFileSync('.analucia/orders/ORD-0001.md','x')\"",
];

for (const openRun of [true, false]) {
  test(`read-only commands are allowed ${openRun ? 'with an open run' : 'without a run'}; writes to protected paths stay blocked`, () => {
    const root = project({ openRun });
    for (const command of READ_ONLY) {
      const r = hook(root, 'Bash', { command });
      assert.equal(r.status, 0, `allowed: ${command}\n${r.stderr}`);
    }
    for (const command of WRITES) {
      const r = hook(root, 'Bash', { command });
      assert.equal(r.status, 2, `blocked: ${command}`);
      assert.match(r.stderr, /Analucia: blocked Bash on .*protected path/);
    }
    for (const [tool, input] of [['Write', { file_path: '.analucia/orders/ORD-0001.md' }], ['Edit', { file_path: 'core/NOMENCLATURE.md' }]]) {
      assert.equal(hook(root, tool, input).status, 2, tool);
    }
  });
}

test('a session start leaves .claude/settings.json byte-identical', () => {
  const root = project({ openRun: false });
  mkdirSync(join(root, '.claude'));
  cpSync(join(REPO, '.claude', 'settings.json'), join(root, '.claude', 'settings.json'));
  const before = readFileSync(join(root, '.claude', 'settings.json'));
  const r = hook(root, null, {}, 'session-start');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Status: /);
  assert.deepEqual(readFileSync(join(root, '.claude', 'settings.json')), before);
  assert.equal(spawnSync(process.execPath, [AOS, 'permissions', 'write', '--root', root], { encoding: 'utf8', env }).status, 0);
  // permissions write uses this repo's marketplace; the profile part must be unchanged as well.
  const after = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(after.permissions, JSON.parse(before.toString()).permissions);
});
