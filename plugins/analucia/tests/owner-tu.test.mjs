// ORD-0046 part 3 (owner's adjustment 3): every Spanish text the plugin addresses to the owner uses tú, never usted.
// The files: the owner review template, the decision brief, the Spanish catalog (which carries the launchers'
// windows), and the director and advisor entrypoints. The test fails on "usted", on "su"/"sus" as the owner's
// possessive and on the formal imperatives. "su"/"sus" that belong to a third party (an order, a file, a credential:
// "sus comprobaciones") are allowed by catalog key, named below; each allowed key must still hold one, so the list
// cannot rot.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PLUGIN = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(`${PLUGIN}${rel}`, 'utf8');

const USTED = /\busted(es)?\b/i;
const POSSESSIVE = /\b(su|sus|suyo|suya|suyos|suyas)\b/i;
// The formal imperatives (and their reflexive forms) that would address the owner as usted.
const FORMAL = /\b(revise|firme|escriba|pulse|haga|elija|diga|apruebe|confirme|responda|abra|ejecute|corrija|decida|indique|lea|marque|presione|cierre|instale|vuelva|copie|pegue|env[ií]e|ingrese|seleccione|verifique|compruebe|acepte|rechace|tenga|mire|introduzca|teclee|reinicie|actualice|elimine|borre|guarde|contin[uú]e|espere)\b/i;

// Catalog keys whose "su"/"sus" is about a thing (an order, a file, a provider, a check), not about the owner.
const THIRD_PERSON = [
  'h.external_artifacts', 'h.executor_tool', 'prompt.change', 'adopt.n.secret', 'adopt.n.backup_stale', 'sign.ready', 'sign.nothing_passed',
  'w.o.5.2', 'next.open_run', 'ceo.ask_path', 'hook.draft_hint', 'drafts.none', 'plan.claude_move', 'claude_md.next', 'w.code', 'w.owner_data',
  'outcome.parts_cap', 'ids.no_code', 'ids.title', 'docs.ok', 'preflight.ok_none', 'preflight.none', 'next.block_ended', 'next.preflight_failed',
  'hook.wrong_project.named', 'review.group', 'sign.rework', 'update.not_found', 'ostatus.part_all',
];

const strings = JSON.parse(read('i18n/es.json')).strings;
const FILES = ['templates/owner-review-doc.md', 'templates/decision-brief.es.md', 'templates/director-entry.md', 'templates/advisor-entry.md'];

test('the Spanish catalog never says usted nor a formal imperative, and "su"/"sus" only where a key is named as a third party', () => {
  for (const [key, text] of Object.entries(strings)) {
    assert.doesNotMatch(text, USTED, `${key}: usted`);
    assert.doesNotMatch(text, FORMAL, `${key}: formal imperative`);
    if (POSSESSIVE.test(text)) assert.ok(THIRD_PERSON.includes(key), `${key}: "su"/"sus" addressing the owner? use tu/tus, or name the key as a third party in this test`);
  }
});

test('every key allowed as a third party still has a "su"/"sus", so the list holds only what it must', () => {
  for (const key of THIRD_PERSON) assert.ok(POSSESSIVE.test(strings[key] ?? ''), `${key} no longer needs its entry`);
});

test('the owner review template, the decision brief and the entrypoints speak in tú', () => {
  for (const rel of FILES) {
    const text = read(rel);
    // The entrypoints are written in English for the roles; only a Spanish line of the owner's wording is checked.
    const lines = rel.endsWith('-entry.md') ? text.split('\n').filter((l) => /[¿¡áéíóúñ]/i.test(l)) : text.split('\n');
    for (const l of lines) {
      assert.doesNotMatch(l, USTED, `${rel}: usted in "${l.slice(0, 70)}"`);
      assert.doesNotMatch(l, POSSESSIVE, `${rel}: su/sus in "${l.slice(0, 70)}"`);
      assert.doesNotMatch(l, FORMAL, `${rel}: formal imperative in "${l.slice(0, 70)}"`);
    }
  }
});

test('the template says "tú" words where it addresses the owner', () => {
  const t = read('templates/owner-review-doc.md');
  assert.match(t, /Documento para ti, el dueño/);
  assert.match(t, /tus clientes, tu equipo o tu dinero/);
  assert.match(t, /solo tú puedes decidir/);
});
