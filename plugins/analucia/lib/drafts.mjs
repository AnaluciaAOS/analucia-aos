// Drafts (ORD-0040 part 2): a session acting as director writes orders in .analucia/drafts/ (ORD-NNNN.md with its
// verify file ORD-NNNN.json), a path that is not protected. Only the owner places them, in `aos sign`: after the
// typed confirmation the tool itself copies each valid draft to the protected paths, records its hashes in
// .analucia/director.lock (written here, never by hand) and admits it. A draft that does not validate stays a draft
// and its reason is shown. This replaces every hand-written placement script.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_DIR, aosCommand } from './cli.mjs';
import { ORDER_ID_RE } from './enums.mjs';
import { formatId, nextId, prefixProblem, projectCode } from './ids.mjs';
import { admit } from './lifecycle.mjs';
import { LOCK_REL, hashLF, readLock } from './lock.mjs';
import { appendEvent, logPath, timestampFor } from './log.mjs';
import { replay } from './state.mjs';
import { parseFrontMatter, validateLockText, validateOrderText, validateVerifyText } from './validate.mjs';
import { readBranches } from './verify-refs.mjs';

export const DRAFTS_REL = '.analucia/drafts';
export const DIRECTOR_ENTRY_REL = '.analucia/DIRECTOR.md';
export const BOOTSTRAP_ID = 'ORD-0001';
const ID_RE = ORDER_ID_RE; // either form (ORD-0041 part 1)
const TEMPLATES = fileURLToPath(new URL('../templates/', import.meta.url));
const draftsDir = (root) => join(root, '.analucia', 'drafts');
const git = (root, args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });

// ORD-0042 part 10 (OBS-154): the fixed section "## Business rules" of an order. One rule per list item, each with one
// example with numbers; an order with none writes the single item "- none". Returns undefined when the order has
// no such section, else the rules as text (an empty list for "- none").
export const BUSINESS_RULES_HEADING = '## Business rules';
const NONE_RE = /^none\.?$/i;
function businessRuleItems(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^## Business rules\s*$/.test(l));
  if (start === -1) return undefined;
  const items = [];
  for (const l of lines.slice(start + 1)) {
    if (/^#{1,6} /.test(l)) break;
    const m = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/.exec(l);
    if (m) items.push(m[1].trim());
    else if (l.trim() && items.length) items[items.length - 1] = `${items.at(-1)} ${l.trim()}`;
  }
  return items;
}
export function businessRulesOf(text) {
  const items = businessRuleItems(text);
  if (items === undefined) return undefined;
  return items.filter((i) => !NONE_RE.test(i));
}
// The reasons the section of a draft is not ready ([] when it is right, or when the draft has no section).
function businessRuleProblems(text, where) {
  const items = businessRuleItems(text);
  if (items === undefined) return [];
  const out = [];
  if (!items.length) out.push(`E_FIELD_TYPE ${where}: the section "${BUSINESS_RULES_HEADING}" is empty: list each rule with one example with numbers, or write the single item "- none"`);
  if (items.some((i) => NONE_RE.test(i)) && items.length > 1) out.push(`E_FIELD_TYPE ${where}: "- none" is the only item of the section when there is no rule; here it stands next to ${items.length - 1} other item(s)`);
  items.forEach((item, i) => {
    if (!NONE_RE.test(item) && !/\d/.test(item)) out.push(`E_FIELD_TYPE ${where}: business rule ${i + 1} ("${item}") has no example with numbers: say what the rule gives for one real case`);
  });
  return out;
}

// One front-matter key of an order text, as one line of text, or null.
const orderKey = (text, key) => {
  try {
    const v = parseFrontMatter(text).fields.get(key)?.value;
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
};

const readEvents = (root) => {
  try {
    return readFileSync(logPath(root), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

// Every draft, by order ID: [{ id, order, verify, title, problems, ok }]. `problems` are the reasons it cannot be
// placed, each one sentence that says what to change.
export function listDrafts(root) {
  const dir = draftsDir(root);
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir);
  const ids = [...new Set(names.map((f) => /^([A-Z]{2,5}-[^.]+(?:\.[A-Z])?)\.(?:md|json)$/.exec(f)?.[1]).filter(Boolean))].sort();
  const records = replay(readEvents(root)).records;
  let branches;
  return ids.map((id) => {
    const order = names.includes(`${id}.md`) ? `${DRAFTS_REL}/${id}.md` : null;
    const verify = names.includes(`${id}.json`) ? `${DRAFTS_REL}/${id}.json` : null;
    const problems = [];
    let title = '';
    if (!ID_RE.test(id)) problems.push(`E_ID_FORMAT ${id} is not an order ID (ORD-0000, or <CODE>-0000 with the project code)`);
    const prefix = prefixProblem(root, id, { exists: Boolean(records[id]) });
    if (prefix) problems.push(`E_ID_PREFIX ${prefix}`);
    if (!order) problems.push(`E_FILE_MISSING the order file ${DRAFTS_REL}/${id}.md is missing`);
    else {
      const text = readFileSync(join(root, order), 'utf8');
      try { title = parseFrontMatter(text).fields.get('title')?.value ?? ''; } catch { /* reported below */ }
      for (const p of validateOrderText(text, `${id}.md`, { pinned: true })) problems.push(`${p.code} ${order}:${p.line}: ${p.message}`);
      let risk;
      try { risk = parseFrontMatter(text).fields.get('risk')?.value; } catch { /* reported above */ }
      // ORD-0042 part 7: a draft that builds says what it replaces (placed orders and aos validate are not asked).
      let kind;
      let hasReplaces = false;
      try {
        const fm = parseFrontMatter(text).fields;
        kind = fm.get('kind')?.value;
        hasReplaces = fm.has('replaces');
      } catch { /* reported above */ }
      // ORD-0042 part 10: the business rules of the draft, each with its example with numbers.
      problems.push(...businessRuleProblems(text, order));
      if (kind === 'build' && businessRulesOf(text) === undefined) problems.push(`E_MISSING_FIELD ${order}: a draft of kind build has no section "${BUSINESS_RULES_HEADING}": list each rule with one example with numbers, or write the single item "- none"`);
      if (kind === 'build' && !hasReplaces) problems.push(`E_MISSING_FIELD ${order}: a draft of kind build does not say what it replaces: list the paths in "replaces: […]", or write "replaces: []" when it replaces nothing`);
      if (risk === 'high') problems.push(`E_NO_ROLLBACK ${order}: a risk: high order needs a rollback plan listed in ${LOCK_REL}; drafts place only risk: low and medium`);
    }
    if (!verify) problems.push(`E_FILE_MISSING an order needs its verify file: write ${DRAFTS_REL}/${id}.json ({"order": "${id}", "checks": [{"name", "run", "expect_exit"}]})`);
    else {
      branches ??= readBranches(root);
      for (const p of validateVerifyText(readFileSync(join(root, verify), 'utf8'), `${id}.json`, { movingRefs: { severity: 'error', branches } })) problems.push(`${p.code} ${verify}:${p.line}: ${p.message}`);
    }
    if (records[id] || existsSync(join(root, '.analucia', 'orders', `${id}.md`)) || existsSync(join(root, '.analucia', 'verify', `${id}.json`))) {
      problems.push(`E_RECORD_EXISTS ${id} already exists as a placed order: give the draft a new ID`);
    }
    const rules = order ? businessRulesOf(readFileSync(join(root, order), 'utf8')) ?? [] : [];
    return { id, order, verify, title, problems, rules, ok: problems.length === 0 };
  });
}

// The next free order ID, over the placed orders, the log and the drafts.
export function nextOrderId(root) {
  return nextId(root, 'order');
}

// The lock with `files` added, written by the tool. An existing lock keeps its other keys and entries.
function writeLock(root, files, now) {
  const p = join(root, LOCK_REL);
  const lock = readLock(root) ?? {};
  const next = {
    written_by: 'director',
    date: timestampFor(root, now).slice(0, 10),
    normalization: 'LF',
    ...lock,
    files: { ...(lock.files ?? {}), ...files },
  };
  next.date = timestampFor(root, now).slice(0, 10);
  const text = `${JSON.stringify(next, null, 2)}\n`;
  const problems = validateLockText(text);
  if (problems.length) throw Object.assign(new Error(`${LOCK_REL} would not validate: ${problems[0].message}`), { code: problems[0].code });
  writeFileSync(p, text);
}

// Places the valid drafts among `ids` (default: all). Called only after the owner's typed confirmation at a
// terminal (lib/sign.mjs). Returns { placed: [id], refused: [{ id, problems }] }.
export function placeDrafts(root, { ids, now = new Date() } = {}) {
  const drafts = listDrafts(root).filter((d) => !ids || ids.includes(d.id));
  const placed = [];
  const refused = drafts.filter((d) => !d.ok).map(({ id, problems }) => ({ id, problems }));
  for (const d of drafts.filter((x) => x.ok)) {
    const targets = { [`.analucia/orders/${d.id}.md`]: d.order, [`.analucia/verify/${d.id}.json`]: d.verify };
    const before = existsSync(join(root, LOCK_REL)) ? readFileSync(join(root, LOCK_REL)) : null;
    try {
      const hashes = {};
      for (const [to, from] of Object.entries(targets)) {
        mkdirSync(join(root, to, '..'), { recursive: true });
        const bytes = Buffer.from(readFileSync(join(root, from), 'utf8').replace(/\r\n/g, '\n'), 'utf8');
        writeFileSync(join(root, to), bytes);
        hashes[to] = hashLF(bytes);
      }
      writeLock(root, hashes, now);
      admit(root, d.id, { now });
    } catch (x) {
      if (!x.code) throw x;
      // Nothing half-placed: the copies and the lock entries of this draft are taken back; the draft stays.
      for (const to of Object.keys(targets)) rmSync(join(root, to), { force: true });
      if (before === null) rmSync(join(root, LOCK_REL), { force: true });
      else writeFileSync(join(root, LOCK_REL), before);
      refused.push({ id: d.id, problems: [`${x.code} ${x.message}`] });
      continue;
    }
    // ORD-0042 part 6: the owner's placement records the decision the draft carries (the key `decision:`), by itself.
    // ORD-0042 part 10: the business rules the owner saw before his confirmation are recorded with it.
    const placedText = readFileSync(join(root, `.analucia/orders/${d.id}.md`), 'utf8');
    const text = orderKey(placedText, 'decision');
    const rules = businessRulesOf(placedText) ?? [];
    if (text || rules.length) {
      appendEvent(root, { type: 'decision.recorded', actor: 'owner', subject: d.id, payload: { text: text ?? `Placement of ${d.id}: ${d.title || 'no title'}`, source: `.analucia/orders/${d.id}.md`, orders: [d.id], ...(rules.length ? { business_rules: rules } : {}) } }, { now });
    }
    for (const from of Object.values(targets)) rmSync(join(root, from), { force: true });
    placed.push(d.id);
  }
  if (placed.length) appendEvent(root, { type: 'operation.logged', actor: 'owner', subject: null, payload: { operation: 'drafts_placed', orders: placed } }, { now });
  return { placed, refused };
}

// ---------- what aos init leaves for the director (plan items) ----------

// The plugin's own repository names the CLI and the templates by their repository path; any other project by the
// absolute path of the installed plugin (as the rules block does, ORD-0029 B).
const render = (root, text) => (existsSync(join(root, 'plugins', 'analucia', 'bin', 'aos.mjs')) ? text
  : text.split('node plugins/analucia/bin/aos.mjs').join(aosCommand()).split('`plugins/analucia/').join(`\`${PLUGIN_DIR}/`));
const template = (name) => readFileSync(join(TEMPLATES, name), 'utf8').replace(/\r\n/g, '\n');
const statusOf = (path, text) => (!existsSync(path) ? 'created' : readFileSync(path, 'utf8').replace(/\r\n/g, '\n') !== text ? 'updated' : 'unchanged');

// .analucia/DIRECTOR.md: how a session acting as director writes a draft. Not CLAUDE.md: the executor entrypoint
// keeps holding only "@AGENTS.md".
export function directorEntryPlan(root) {
  const p = join(root, DIRECTOR_ENTRY_REL);
  const text = render(root, template('director-entry.md'));
  return { item: 'director_entry', status: statusOf(p, text), apply: () => { mkdirSync(join(root, '.analucia'), { recursive: true }); writeFileSync(p, text); } };
}

// Commits that predate the Loop: the project has commits and no order yet (none placed, none drafted, none in the log).
export function needsBootstrap(root) {
  if (git(root, ['rev-parse', '--is-inside-work-tree']).stdout.trim() !== 'true') return false;
  if (Number(git(root, ['rev-list', '--count', 'HEAD']).stdout.trim() || 0) < 1) return false;
  for (const d of ['orders', 'drafts']) {
    const dir = join(root, '.analucia', d);
    if (existsSync(dir) && readdirSync(dir).some((f) => /^[A-Z]{2,5}-\d/.test(f))) return false;
  }
  return Object.keys(replay(readEvents(root)).orders).length === 0;
}

// The bootstrap order, already written, as a draft: bring the existing commits under an order and make the first
// push through the guard (OBS-130). The owner's first click places it.
// `code`: the project code chosen in this same init (it is not in project.json yet when the plan is built).
export function bootstrapDraftPlan(root, { now = new Date(), code = projectCode(root) } = {}) {
  const wanted = needsBootstrap(root);
  const apply = () => {
    mkdirSync(draftsDir(root), { recursive: true });
    const created = timestampFor(root, now).slice(0, 10);
    // The first order of the project carries its code when it has one (ORD-0041 part 1).
    const id = formatId('order', 1, { code: code || null });
    const own = (text) => text.split(BOOTSTRAP_ID).join(id);
    writeFileSync(join(draftsDir(root), `${id}.md`), own(render(root, template('bootstrap-order.md'))).split('{created}').join(created));
    writeFileSync(join(draftsDir(root), `${id}.json`), own(template('bootstrap-verify.json')));
  };
  return { item: 'bootstrap_draft', status: wanted ? 'created' : 'unchanged', apply };
}
