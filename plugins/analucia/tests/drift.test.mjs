// Drift guard: core/enums.json must hold the same closed lists as core/NOMENCLATURE.md (SPEC-0001)
// and core/SPEC-0003-RULES-ERRORS-RISK-COST.md §3.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { enums } from '../lib/enums.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = join(here, '..', '..', '..');
const NOMENCLATURE = 'core/NOMENCLATURE.md';
const SPEC3 = 'core/SPEC-0003-RULES-ERRORS-RISK-COST.md';

// ORD-0033 A.2: nothing is read at load time. A public checkout has no private specs or records (release manifest):
// each test that needs one skips and names the missing path. A file that is present but unreadable or malformed
// fails its test with a message, never silently.
const absent = (...rels) => rels.filter((r) => !existsSync(join(repo, r)));
const skipWithout = (...rels) => {
  const gone = absent(...rels);
  return gone.length ? `not in this checkout: ${gone.join(', ')} (private to the source repository; a public checkout has none)` : false;
};
const texts = new Map();
const read = (rel) => {
  if (!texts.has(rel)) texts.set(rel, readFileSync(join(repo, rel), 'utf8').replace(/\r\n/g, '\n'));
  return texts.get(rel);
};
const spec = () => read(NOMENCLATURE);
const spec3 = () => read(SPEC3);

// Event types added after SPEC-0001 §6, each with the director document that introduced it. The drift test
// below checks that the type is named (in backticks) in that document, so the list cannot grow silently.
const LATER_EVENT_TYPES = {
  'eval.run': '.analucia/orders/ORD-0012.md',
  'adoption.audited': 'core/SPEC-0006-ADOPTION-AUDIT.md',
  'onboarding.started': '.analucia/amendments/AMD-0004.md',
  'onboarding.completed': '.analucia/amendments/AMD-0004.md',
  'owner.signed': '.analucia/amendments/AMD-0005.md',
  'hosting.chosen': '.analucia/amendments/AMD-0006.md',
  'review.requested': '.analucia/orders/ORD-0023.md',
  'review.decision': '.analucia/orders/ORD-0023.md',
  'session.start': '.analucia/orders/ORD-0023.md',
  'session.end': '.analucia/orders/ORD-0023.md',
  'backup.pushed': '.analucia/orders/ORD-0024.md',
};

// SPEC-0003 §3: a table "| `list` | `a`, `b`, `c` |".
function spec3Lists() {
  const m = /^## 3\. [^\n]*\n([\s\S]*?)(?=^## )/m.exec(spec3());
  assert.ok(m, 'section 3 not found in SPEC-0003');
  const out = {};
  for (const l of m[1].split('\n').filter((x) => /^\| `[a-z_]+` \|/.test(x))) {
    const [, name, values] = l.split('|').map((c) => c.trim());
    out[name.replace(/`/g, '')] = [...values.matchAll(/`([^`]+)`/g)].map((x) => x[1]);
  }
  return out;
}

const section = (n) => {
  const m = new RegExp(`^## ${n}\\. [^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(spec());
  assert.ok(m, `section ${n} not found in NOMENCLATURE.md`);
  return m[1];
};
const ticks = (s) => [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
const column = (sec, i) => sec.split('\n')
  .filter((l) => l.startsWith('|') && !/^\|\s*-/.test(l))
  .slice(1) // header row
  .flatMap((l) => ticks(l.split('|')[i + 1] ?? ''));
// Plain-text cells of a table column (section 10 writes roles without backticks).
const plainColumn = (sec, i) => sec.split('\n')
  .filter((l) => l.startsWith('|') && !/^\|\s*-/.test(l))
  .slice(1)
  .map((l) => (l.split('|')[i + 1] ?? '').replace(/`/g, '').trim())
  .filter(Boolean);
const lineOf = (sec, re) => {
  const l = sec.split('\n').find((x) => re.test(x));
  assert.ok(l, `line ${re} not found`);
  return l;
};
const uniq = (a) => [...new Set(a)];

// Each closed list as written in the specification, computed when a test runs (ORD-0033 A.2).
const FROM_NOMENCLATURE = {
  roles: () => column(section(1), 0),
  // Actors = the four roles plus every role named in the §10 command table ("system" runs verification).
  // "any" there means "any actor", not an actor of its own.
  actors: () => uniq([...column(section(1), 0), ...plainColumn(section(10), 1).filter((r) => r !== 'any')]),
  record_types: () => column(section(2), 0),
  order_kinds: () => column(section(3), 0),
  order_states: () => column(section(4), 0),
  terminal_states: () => lineOf(section(4), /^terminal:/).replace('terminal:', '').split('·').map((s) => s.trim()),
  run_outcomes: () => ticks(lineOf(section(5), /^`done`/)),
  evidence_levels: () => ticks(lineOf(section(7), /^`verified`/)),
  admission_decisions: () => ticks(lineOf(section(6), /order\.admitted/).split('Admission decision:')[1]),
  ask_kinds: () => column(section(8), 0),
  event_types: () => [...column(section(6), 0), ...Object.keys(LATER_EVENT_TYPES)],
  relation_fields: () => ticks(lineOf(section(6), /^Relations between records/)),
  deploy_policies: () => ticks(/`deploy\.policy` \(([^)]*)\)/.exec(section(11))[1]),
};
// SPEC-0003 §3 lists (risk_levels, cost_effects, cost_alert_thresholds); the first test checks §3 defines exactly these.
const SPEC3_LISTS = ['risk_levels', 'cost_effects', 'cost_alert_thresholds'];
const fromSpec = () => ({ ...Object.fromEntries(Object.entries(FROM_NOMENCLATURE).map(([k, f]) => [k, f()])), ...spec3Lists() });

test('drift: SPEC-0003 §3 defines exactly the three new lists', { skip: skipWithout(SPEC3) }, () => {
  assert.deepEqual(Object.keys(spec3Lists()).sort(), [...SPEC3_LISTS].sort());
});

for (const key of [...Object.keys(FROM_NOMENCLATURE), ...SPEC3_LISTS]) {
  const inNomenclature = key in FROM_NOMENCLATURE;
  test(`drift: ${key} matches the specification`, { skip: skipWithout(inNomenclature ? NOMENCLATURE : SPEC3) }, () => {
    const specValues = inNomenclature ? FROM_NOMENCLATURE[key]() : spec3Lists()[key];
    assert.ok(Array.isArray(specValues), `${key}: SPEC-0003 §3 has no list "${key}"`);
    assert.ok(Array.isArray(enums[key]), `enums.json has no list "${key}"`);
    assert.ok(specValues.length > 0, `no values extracted for ${key}`);
    // Compared as text: thresholds are numbers in enums.json and text in the spec.
    const mine = enums[key].map(String);
    const missingInEnums = specValues.filter((v) => !mine.includes(String(v)));
    const missingInSpec = mine.filter((v) => !specValues.map(String).includes(v));
    assert.deepEqual(missingInEnums, [], `${key}: in NOMENCLATURE.md but not in enums.json`);
    assert.deepEqual(missingInSpec, [], `${key}: in enums.json but not in NOMENCLATURE.md`);
  });
}

test('drift: every list in enums.json is covered by the drift guard', { skip: skipWithout(NOMENCLATURE, SPEC3) }, () => {
  const lists = Object.entries(enums).filter(([, v]) => Array.isArray(v)).map(([k]) => k);
  const covered = fromSpec();
  assert.deepEqual(lists.filter((k) => !(k in covered)), []);
});

test('drift: every enums.json value appears in NOMENCLATURE.md or SPEC-0003', { skip: skipWithout(NOMENCLATURE, SPEC3) }, () => {
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const [key, values] of Object.entries(enums)) {
    if (!Array.isArray(values)) continue;
    for (const v of values) {
      if (key === 'event_types' && v in LATER_EVENT_TYPES) continue; // checked against its own source document
      const re = new RegExp(`(?<![\\w.])${escape(String(v))}(?![\\w])`);
      assert.ok(re.test(spec()) || re.test(spec3()), `${key}: "${v}" does not appear in NOMENCLATURE.md or SPEC-0003`);
    }
  }
});

test('drift: record ID prefixes match section 2', { skip: skipWithout(NOMENCLATURE) }, () => {
  const rows = section(2).split('\n').filter((l) => /^\| `[a-z]+` \|/.test(l));
  const spec2 = Object.fromEntries(rows.map((l) => {
    const [, rec, id] = l.split('|').map((c) => ticks(c)[0]);
    return [rec, id];
  }).filter(([, id]) => /^[A-Z]+-\d{4}$/.test(id)).map(([rec, id]) => [rec, id.split('-')[0]]));
  assert.deepEqual(enums.record_id_prefixes, spec2);
});

test('drift: every event type added after SPEC-0001 is named in the director document that introduced it', { skip: skipWithout(...new Set(Object.values(LATER_EVENT_TYPES))) }, () => {
  for (const [type, doc] of Object.entries(LATER_EVENT_TYPES)) {
    const text = read(doc);
    assert.ok(text.includes(`\`${type}\``), `${type} is not named in ${doc}`);
    assert.ok(enums.event_types.includes(type), `${type} is not in enums.json`);
  }
});
