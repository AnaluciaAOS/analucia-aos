// ORD-0042 part 9 (OBS-153): a document for the owner is written for the owner. The template
// `owner-review-doc.md` ends with the fixed section `## Decisiones`: each decision is one question followed by its
// options, one per line (`- A) …`, `- B) …`); a document with nothing to decide writes the single line `Ninguna`.
// `aos review request` refuses a document without the section, or with a decision that has fewer than two options.
// Documents already requested are not affected.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { blockTemplate } from '../lib/guards.mjs';
import { appendEvent, logPath, readLog } from '../lib/log.mjs';
import { decisionsProblem, reviewState } from '../lib/review.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const PLUGIN = fileURLToPath(new URL('..', import.meta.url));
const env = { ...process.env };
delete env.CLAUDE_PROJECT_DIR;
delete env.CLAUDE_CODE_SESSION_ID;
const aos = (root, args) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input: '', env });

function project() {
  const root = mkdtempSync(join(tmpdir(), 'aos-reviewdoc-'));
  mkdirSync(join(root, '.analucia'), { recursive: true });
  writeFileSync(join(root, '.analucia', 'project.json'), '{"wip_limit":1,"locale":"en"}\n');
  writeFileSync(logPath(root), '');
  appendEvent(root, { type: 'record.created', actor: 'director', subject: 'ORD-0001' });
  return root;
}
const doc = (root, rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); return rel; };
const request = (root, rel) => aos(root, ['review', 'request', rel, '--order', 'ORD-0001']);
const BODY = '# Precios de temporada\n\nSi un producto cuesta 8 y el precio de referencia es 20, el precio de venta es 22.\n\n';

test('the template: business language, an example with numbers for every rule, and the fixed last section', () => {
  const template = readFileSync(join(PLUGIN, 'templates', 'owner-review-doc.md'), 'utf8');
  assert.match(template, /^## Decisiones$/m);
  assert.ok(template.trimEnd().split('\n## ').at(-1).startsWith('Decisiones'), 'it is the last section');
  assert.match(template, /^- A\) /m);
  assert.match(template, /^- B\) /m);
  assert.match(template, /Ninguna/);
  assert.match(template, /\d/, 'an example with numbers');
  assert.equal(decisionsProblem(template), null, 'the template itself passes the check');
});

test('the shape of the section: a question followed by at least two options, or the single line Ninguna', () => {
  assert.equal(decisionsProblem(`${BODY}## Decisiones\n\nNinguna\n`), null);
  assert.equal(decisionsProblem(`${BODY}## Decisiones\n\n¿Se redondea el precio?\n- A) Sí, a 0.10\n- B) No\n\n¿Aplica a todos los productos?\n- A) Sí\n- B) Solo a los de temporada\n- C) Lo decido después\n`), null);
  assert.match(decisionsProblem(BODY), /has no section "## Decisiones"/);
  assert.match(decisionsProblem(`${BODY}## Decisiones\n`), /is empty/);
  assert.match(decisionsProblem(`${BODY}## Decisiones\n\n¿Se redondea el precio?\n- A) Sí, a 0.10\n`), /"¿Se redondea el precio\?" has 1 option/);
  assert.match(decisionsProblem(`${BODY}## Decisiones\n\n¿Se redondea el precio?\n`), /has 0 option/);
  assert.match(decisionsProblem(`${BODY}## Decisiones\n\n- A) Sí\n- B) No\n`), /an option before any question/);
  // The section is the one that carries the decisions wherever it is; the text after the next heading is not part of it.
  assert.equal(decisionsProblem(`${BODY}## Decisiones\n\nNinguna\n\n## Anexo\n\nTexto.\n`), null);
});

test('aos review request refuses a document without its decisions, with the line to add; a good one is registered', () => {
  const root = project();
  const before = readFileSync(logPath(root), 'utf8');
  const missing = request(root, doc(root, 'docs/design.md', BODY));
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /aos review request: E_REVIEW_DECISIONS .*has no section "## Decisiones"/);
  assert.match(missing.stderr, /add at the end: ## Decisiones/);
  assert.match(missing.stderr, /next \(executor\)/);
  const few = request(root, doc(root, 'docs/few.md', `${BODY}## Decisiones\n\n¿Se redondea?\n- A) Sí\n`));
  assert.equal(few.status, 1);
  assert.match(few.stderr, /E_REVIEW_DECISIONS .*has 1 option/);
  assert.equal(readFileSync(logPath(root), 'utf8'), before, 'nothing registered');
  const ok = request(root, doc(root, 'docs/ok.md', `${BODY}## Decisiones\n\n¿Se redondea?\n- A) Sí\n- B) No\n`));
  assert.equal(ok.status, 0, ok.stderr);
  const none = request(root, doc(root, 'docs/none.md', `${BODY}## Decisiones\n\nNinguna\n`));
  assert.equal(none.status, 0, none.stderr);
  assert.equal(readLog(root).events.filter((e) => e.type === 'review.requested').length, 2);
  // A picture or a page that is not text cannot carry the section and is registered as before.
  assert.equal(request(root, doc(root, 'docs/mockup.png', 'not really a picture')).status, 0);
});

test('documents already requested are not affected', () => {
  const root = project();
  const rel = doc(root, 'docs/old.md', BODY);
  // Requested before this rule existed (the event is already in the log).
  appendEvent(root, { type: 'review.requested', actor: 'executor', subject: 'ORD-0001', payload: { path: rel, sha256: 'a'.repeat(64), order: 'ORD-0001' } });
  const state = reviewState(root);
  assert.equal(state.length, 1);
  assert.equal(state[0].path, rel);
  assert.equal(aos(root, ['derive']).status, 0);
  assert.equal(aos(root, ['validate']).status, 0);
});

test('the director entrypoint and the rules block say it in one sentence each', () => {
  for (const text of [readFileSync(join(PLUGIN, 'templates', 'director-entry.md'), 'utf8'), blockTemplate()]) {
    const line = text.split('\n').find((l) => /owner-review-doc\.md/.test(l));
    assert.ok(line, 'one sentence that names the template');
    assert.match(line, /## Decisiones/);
    assert.match(line, /out of scope/);
  }
});
