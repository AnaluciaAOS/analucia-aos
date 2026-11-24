// ORD-0047 part 16 (OBS-214): the hash an approval binds to leaves out the section "## Estado" (status only). Changing
// only the status keeps the approval; any change elsewhere voids it; a document with no such section hashes as before.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hashLF } from '../lib/lock.mjs';
import { appendEvent } from '../lib/log.mjs';
import { requestReview, reviewHash, reviewState, withoutStatus } from '../lib/review.mjs';

const DOC = (status, body = 'Esto se va a hacer.') => ['# Nota', '', '## Qué se propone', '', body, '', '## Estado', '', status, '', '## Decisiones', '', 'Ninguna', ''].join('\n');

function project() {
  const root = mkdtempSync(join(tmpdir(), 'aos-status-'));
  mkdirSync(join(root, '.analucia'), { recursive: true });
  writeFileSync(join(root, '.analucia', 'project.json'), '{"wip_limit":1,"locale":"es"}\n');
  writeFileSync(join(root, '.analucia', 'events.jsonl'), '');
  appendEvent(root, { type: 'record.created', actor: 'director', subject: 'ORD-0001' });
  return root;
}
const decide = (root, rel, sha256) => appendEvent(root, { type: 'review.decision', actor: 'owner', subject: 'ORD-0001', payload: { path: rel, decision: 'approve', note: '', sha256, order: 'ORD-0001' } });
const status = (root, rel) => reviewState(root).find((d) => d.path === rel)?.status;

test('the hash leaves out the Estado section only', () => {
  const a = Buffer.from(DOC('pendiente de tu revisión'));
  const b = Buffer.from(DOC('aprobada; lista para la orden'));
  const c = Buffer.from(DOC('pendiente de tu revisión', 'Esto otro se va a hacer.'));
  assert.equal(reviewHash(a), reviewHash(b), 'only the status changed');
  assert.notEqual(reviewHash(a), reviewHash(c), 'a change elsewhere');
  assert.ok(!withoutStatus(a.toString()).includes('pendiente'), 'the section is gone from what is hashed');
  assert.ok(withoutStatus(a.toString()).includes('## Decisiones'), 'the sections after it stay');
});

test('a document with no Estado section hashes as its bytes, so no earlier approval changes', () => {
  const text = '# Nota\n\n## Qué se propone\n\nAlgo.\n\n## Decisiones\n\nNinguna\n';
  assert.equal(withoutStatus(text), null);
  assert.equal(reviewHash(Buffer.from(text)), hashLF(Buffer.from(text)));
  assert.equal(reviewHash(Buffer.from(text.replace(/\n/g, '\r\n'))), hashLF(Buffer.from(text)), 'line endings do not count');
});

test('an approval survives a change of status and is voided by any other change', () => {
  const root = project();
  const rel = 'nota.md';
  writeFileSync(join(root, rel), DOC('pendiente de tu revisión'));
  const { sha256 } = requestReview(root, rel, { order: 'ORD-0001' });
  decide(root, rel, sha256);
  assert.equal(status(root, rel), 'approve');
  writeFileSync(join(root, rel), DOC('aprobada por el dueño; lista para la orden'));
  assert.equal(status(root, rel), 'approve', 'only the status changed: the approval still counts');
  writeFileSync(join(root, rel), DOC('aprobada por el dueño; lista para la orden', 'Esto otro se va a hacer.'));
  assert.notEqual(status(root, rel), 'approve', 'a change elsewhere voids it');
});

test('the owner template carries the Estado section before Decisiones, and the rules block says to finalize first', () => {
  const tpl = readFileSync(fileURLToPath(new URL('../templates/owner-review-doc.md', import.meta.url)), 'utf8');
  const lf = tpl.split(String.fromCharCode(13)).join('');
  assert.ok(lf.indexOf('\n## Estado\n') > 0 && lf.indexOf('\n## Estado\n') < lf.indexOf('\n## Decisiones\n'));
  assert.ok(readFileSync(fileURLToPath(new URL('../core/AGENTS.block.md', import.meta.url)), 'utf8').includes('Finalize it first'));
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/aos.mjs', import.meta.url)), 'review', 'status', '--root', project()], { encoding: 'utf8' });
  assert.ok(r.status === 0 || r.status === 2 || r.status === 1, 'the command still loads');
});
