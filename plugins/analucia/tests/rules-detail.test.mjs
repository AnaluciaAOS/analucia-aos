// ORD-0043, AMD-0016 section 1: the always-loaded rules block keeps its limit of 8192 bytes; the detail of six topics
// lives in docs/RULES-DETAIL.md, read on demand, and the block keeps one pointer line for each.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BEGIN, END, blockTemplate } from '../lib/guards.mjs';

const read = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const detail = read('docs/RULES-DETAIL.md');
const headings = detail.split('\n').filter((l) => l.startsWith('## ')).map((l) => l.slice(3).trim());
// A pointer names its heading as: RULES-DETAIL "<heading>".
const pointers = (text) => [...text.matchAll(/RULES-DETAIL "([^"]+)"/g)].map((m) => m[1]);

const SIX = ['Contributor', 'Orders without pins', 'Cost', 'Push guard and permission profile', 'Owner sheet and asks', 'Click launchers'];

// AMD-0019 section 1: three more topics left the block (400 bytes free).
const MOVED_BY_AMD_0019 = ['Risk and versions', 'Copies of real data', 'Derived state'];
test('AMD-0019: the three topics moved last have a heading and one pointer line; the block has 400 bytes free', () => {
  const lines = blockTemplate().split('\n');
  for (const h of MOVED_BY_AMD_0019) {
    assert.ok(headings.includes(h), `heading ${h}`);
    assert.equal(lines.filter((l) => l.includes(`RULES-DETAIL "${h}"`)).length, 1, `one pointer line for ${h}`);
  }
  for (const s of [
    '`risk`: low | medium | high. high → `run start` needs `.analucia/rollback/ORD-NNNN.md` in director.lock (`E_NO_ROLLBACK`)',
    'Only low may be closed by the director (`aos close --as director`).',
    '`aos admit` (director) pins the plugin and spec versions; the order follows them until it closes.',
    'record it (`aos scratch add ORD-NNNN --path <folder> [--pid <n>]`), delete only what the order names, and leave none before `done` (`aos scratch check ORD-NNNN`).',
    'State is derived: `aos derive` → `.analucia/views/` (never edited); `aos history ORD-NNNN` queries one record.',
    '`AGENTS.md` and `CLAUDE.md` hold rules only, never state; `CLAUDE.md` is `@AGENTS.md`.',
  ]) assert.ok(detail.includes(s), s);
  assert.ok(Buffer.byteLength(`${BEGIN}\n${blockTemplate()}${END}`, 'utf8') <= 8192 - 400);
});

test('every heading a pointer line of the rules block names exists in the document', () => {
  const named = pointers(blockTemplate());
  assert.ok(named.length >= SIX.length, `${named.length} pointers`);
  for (const h of named) assert.ok(headings.includes(h), `RULES-DETAIL.md has the heading "${h}"`);
});

test('the six topics left the block: each has its heading in the document and exactly one pointer line in the block', () => {
  const lines = blockTemplate().split('\n');
  for (const h of SIX) {
    assert.ok(headings.includes(h), `heading ${h}`);
    assert.equal(lines.filter((l) => l.includes(`RULES-DETAIL "${h}"`)).length, 1, `one pointer line for ${h}`);
  }
  // The block says once where the document is, by the path the block template rewrites for other projects.
  assert.match(blockTemplate(), /`plugins\/analucia\/docs\/RULES-DETAIL\.md`/);
  assert.match(read('docs/INDEX.md'), /\(RULES-DETAIL\.md\)/);
});

test('nothing moved is lost: the sentences that left the block are in the document', () => {
  for (const s of [
    '`contributor` (third-party human): delivers on a branch for review; never merges to a protected branch, never closes.',
    'Orders without pins (ORD-0001..0007) follow SPEC-0002.',
    '`aos cost record` / `aos cost status`: alerts at 50/80/100% inform the owner and never stop work.',
    'the remote URL user and the credential user must equal `github_owner` in `.analucia/project.json`; no credential in the URL (`E_SECRET_IN_URL`), no secret in added lines (`E_SECRET`).',
    'force pushes, `git reset --hard`, `rm -rf` and reading `.env*`, `*.pem`, `*.key` are denied.',
    'The owner\'s channel is one spreadsheet (`aos ceo export`); only the owner imports it (`aos ceo import <file>`, own TTY, `CONFIRM`). Agents never edit it.',
    'Asks are director files (`.analucia/asks/ASK-NNNN.md`, `aos ask open`); only the owner resolves them, through the sheet.',
    'INICIAR (`aos init`), FIRMAR (`aos sign`), DETENER (`aos halt`), REANUDAR (`aos resume`), IMPORTAR (`aos ceo import`), REPARAR (`aos repair-log`)',
  ]) assert.ok(detail.includes(s), s);
});

test('what never leaves the block is still there, and the block is under its limit', () => {
  const block = blockTemplate();
  for (const [name, re] of [
    ['owner', /^- `owner` \(human\)/m], ['director', /^- `director` \(supervisor agent\)/m], ['executor', /^- `executor` \(coding agent/m],
    ['no order file, no work', /^### No order file, no work$/m], ['the executor loop', /^### Executor loop/m], ['its outcomes', /done → delivered/],
    ['the protected paths', /`\.analucia\/orders\/\*\*`/], ['the halt', /^### Halt$/m],
    ['never run an owner-only command', /never run (them|those commands) yourself/], ['the commit trailer', /`Analucia-Order: ORD-NNNN`/],
    ['push only through the guard', /Push only through the `pre-push` guard/], ['never print or type a secret', /Never print or type a secret/],
    ['where state lives', /^### Where state lives$/m], ['the pointer to the docs', /docs\/INDEX\.md/],
  ]) assert.match(block, re, name);
  assert.ok(Buffer.byteLength(`${BEGIN}\n${block}${END}`, 'utf8') <= 8192);
});
