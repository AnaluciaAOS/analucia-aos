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
import { formatId, nextId, parseId, prefixProblem, projectCode } from './ids.mjs';
import { admit } from './lifecycle.mjs';
import { scanFiles } from './denylist.mjs';
import { readProject } from './cost.mjs';
import { LOCK_REL, hashLF, readLock } from './lock.mjs';
import { appendEvent, logPath, timestampFor } from './log.mjs';
import { replay } from './state.mjs';
import { parseFrontMatter, validateLockText, validateOrderText, validateVerifyText } from './validate.mjs';
import { readBranches } from './verify-refs.mjs';
import { screensOf } from './smoke-check.mjs';
import { assumesProblems, baseProblems, requestPath, requestProblems, secretAskProblems } from './draft-request.mjs';

export const DRAFTS_REL = '.analucia/drafts';
export const DIRECTOR_ENTRY_REL = '.analucia/DIRECTOR.md';
export const BOOTSTRAP_ID = 'ORD-0001';
const ID_RE = ORDER_ID_RE; // either form (ORD-0041 part 1)
const TEMPLATES = fileURLToPath(new URL('../templates/', import.meta.url));
const draftsDir = (root) => join(root, '.analucia', 'drafts');

// ORD-0047 part 9 (AMD-0029, OBS-211): a draft is named by its topic (`draft-<topic>.md`, `.json`, `.request.md`) and
// writes `{id}` wherever its own ID goes; the number is given when it is placed, so numbers follow the real order.
export const TOPIC_DRAFT_RE = /^draft-[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const ID_PLACEHOLDER = '{id}';
export const isTopicDraft = (id) => TOPIC_DRAFT_RE.test(String(id));
export const topicOf = (id) => String(id).replace(/^draft-/, '');
const withId = (text, id) => String(text).split(ID_PLACEHOLDER).join(id);
export const NAMING_LINE = 'name a draft by its topic: draft-<topic>.md with draft-<topic>.json and draft-<topic>.request.md (lowercase letters, digits and dashes), and write {id} wherever the order needs its own ID: it gets its number when it is placed';
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
export const orderKey = (text, key) => {
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

// ORD-0047 parts 1 and 2: what a draft that promises something visible, or adds screens, must carry in its verify file.
// `orderText` and `verifyText` are the two files of the draft; returns sentences that say what to add.
export function promiseProblems(orderText, verifyText, where) {
  const out = [];
  let fm;
  try { fm = parseFrontMatter(orderText).fields; } catch { return out; }
  let runs = [];
  try { runs = (JSON.parse(verifyText).checks ?? []).map((c) => String(c?.run ?? '')); } catch { return out; }
  const promises = fm.get('promises')?.value;
  if (Array.isArray(promises) && promises.length) {
    const live = runs.filter((r) => /\blive check\b/.test(r)).length;
    if (live < promises.length) out.push(`E_MISSING_FIELD ${where}: the order promises ${promises.length} thing(s) the owner will see (${promises.map((p) => JSON.stringify(p)).join(', ')}) and its verify file runs "aos live check" ${live} time(s): add one check per promise: aos live check <published address> --expect "<what he will see>" [--total <n> --base <n>]`);
  }
  const kind = fm.get('kind')?.value;
  if (['build', 'ux'].includes(kind) && screensOf(orderText).length && !runs.some((r) => /\bsmoke check\b/.test(r))) {
    out.push(`E_MISSING_FIELD ${where}: the order adds or changes screens (key "screens") and its verify file does not run "aos smoke check <ID>": add the check`);
  }
  return out;
}

// ORD-0047 part 5 (OBS-207): a draft with `touches_db: true` runs, in its verify file, the project's own script in its
// dry-run mode and `aos sql split` on the SQL file, before delivery.
export function touchesDbProblems(orderText, verifyText, where) {
  let fm;
  try { fm = parseFrontMatter(orderText).fields; } catch { return []; }
  if (fm.get('touches_db')?.value !== 'true') return [];
  let runs = [];
  try { runs = (JSON.parse(verifyText).checks ?? []).map((c) => String(c?.run ?? '')); } catch { return []; }
  const out = [];
  if (!runs.some((r) => /--dry[-_]?run\b/.test(r))) out.push(`E_MISSING_FIELD ${where}: the order touches a database (touches_db: true) and its verify file never runs the project's own script in its dry-run mode against the SQL file of the order: add a check such as: node <the project's script> --dry-run <the SQL file>`);
  if (!runs.some((r) => /\bsql split\b/.test(r))) out.push(`E_MISSING_FIELD ${where}: the order touches a database (touches_db: true) and its verify file does not run "aos sql split <the SQL file>": add the check`);
  return out;
}

// Every draft, by order ID: [{ id, order, verify, title, problems, ok }]. `problems` are the reasons it cannot be
// placed, each one sentence that says what to change.
export function listDrafts(root) {
  const dir = draftsDir(root);
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir);
  const ids = [...new Set(names.map((f) => /^([A-Z]{2,5}-[^.]+(?:\.[A-Z])?|draft-[a-z0-9-]+)\.(?:md|json)$/.exec(f)?.[1]).filter(Boolean))].sort();
  const records = replay(readEvents(root)).records;
  let branches;
  const wouldBe = nextOrderId(root); // what a draft named by topic is validated as: the ID it would get now
  let given = wouldBe;
  return ids.map((id) => {
    const topic = isTopicDraft(id);
    const sub = (text) => (topic ? withId(text, wouldBe) : text);
    const readSub = (rel) => sub(readFileSync(join(root, rel), 'utf8'));
    const order = names.includes(`${id}.md`) ? `${DRAFTS_REL}/${id}.md` : null;
    const verify = names.includes(`${id}.json`) ? `${DRAFTS_REL}/${id}.json` : null;
    const problems = [];
    const warnings = [];
    let title = '';
    if (!topic && !ID_RE.test(id)) problems.push(`E_ID_FORMAT ${id} is not an order ID (ORD-0000, or <CODE>-0000 with the project code); ${NAMING_LINE}`);
    else if (!topic) warnings.push(`${id} is named with a number: it is placed as it is, but ${NAMING_LINE}`);
    const prefix = topic ? null : prefixProblem(root, id, { exists: Boolean(records[id]) });
    if (prefix) problems.push(`E_ID_PREFIX ${prefix}`);
    if (!order) problems.push(`E_FILE_MISSING the order file ${DRAFTS_REL}/${id}.md is missing`);
    else {
      const text = readSub(order);
      try { title = parseFrontMatter(text).fields.get('title')?.value ?? ''; } catch { /* reported below */ }
      if (topic) {
        let own;
        try { own = parseFrontMatter(readFileSync(join(root, order), 'utf8')).fields.get('id')?.value; } catch { /* reported below */ }
        if (own !== ID_PLACEHOLDER) problems.push(`E_ID_FORMAT ${order}: a draft named by topic has "id: {id}" (it has ${JSON.stringify(own ?? null)}): the number is given when it is placed; ${NAMING_LINE}`);
      } else if (/\{id\}/.test(text)) warnings.push(`${order} writes {id} but is named with a number: ${NAMING_LINE}`);
      for (const p of validateOrderText(text, `${topic ? wouldBe : id}.md`, { pinned: true })) problems.push(`${p.code} ${order}:${p.line}: ${p.message}`);
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
    if (!verify) problems.push(`E_FILE_MISSING an order needs its verify file: write ${DRAFTS_REL}/${id}.json ({"order": "${topic ? ID_PLACEHOLDER : id}", "checks": [{"name", "run", "expect_exit"}]})`);
    else {
      branches ??= readBranches(root);
      for (const p of validateVerifyText(readSub(verify), `${topic ? wouldBe : id}.json`, { movingRefs: { severity: 'error', branches }, grepAscii: true })) problems.push(`${p.code} ${verify}:${p.line}: ${p.message}`);
    }
    if (order && verify) {
      problems.push(...promiseProblems(readSub(order), readSub(verify), order));
      problems.push(...touchesDbProblems(readSub(order), readSub(verify), order));
    }
    // ORD-0047 part 7 (OBS-202, OBS-203, OBS-209): the request file, the real base, what the draft assumes, no secret asked.
    if (order) {
      const orderText = readSub(order);
      const requestRel = `${DRAFTS_REL}/${requestPath(id)}`;
      const requestText = names.includes(requestPath(id)) ? readFileSync(join(root, requestRel), 'utf8') : null;
      problems.push(...requestProblems(requestText, requestRel));
      let fm;
      try { fm = parseFrontMatter(orderText).fields; } catch { /* reported above */ }
      if (fm) {
        problems.push(...baseProblems(root, fm.get('base')?.value, order));
        const assumes = fm.get('assumes')?.value;
        if (Array.isArray(assumes)) problems.push(...assumesProblems(root, assumes, order));
      }
      problems.push(...secretAskProblems(orderText, order));
      if (requestText) problems.push(...secretAskProblems(requestText, requestRel));
    }
    // ORD-0047 part 13 (OBS-191): the release guard's matcher over the draft's own files.
    {
      const own = [order, verify, names.includes(requestPath(id)) ? `${DRAFTS_REL}/${requestPath(id)}` : null].filter(Boolean);
      const deny = scanFiles(root, readProject(root) ?? {}, own);
      if (deny.missing) problems.push(`E_DENYLIST_FILE .analucia/project.json names a release_denylist and ${deny.missing}`);
      if (deny.hits.length) problems.push(`E_DENYLIST_FILE a forbidden name is in ${deny.hits.join(', ')}`);
    }
    if (!topic && (records[id] || existsSync(join(root, '.analucia', 'orders', `${id}.md`)) || existsSync(join(root, '.analucia', 'verify', `${id}.json`)))) {
      problems.push(`E_RECORD_EXISTS ${id} already exists as a placed order: give the draft a new ID`);
    }
    const rules = order ? businessRulesOf(readSub(order)) ?? [] : [];
    const ok = problems.length === 0;
    const entry = { id, order, verify, title, problems, warnings, rules, ok };
    if (topic) {
      entry.topic = topicOf(id);
      entry.numbered = false;
      if (ok) { entry.would_get = given; given = bump(root, given); }
    }
    return entry;
  });
}

// The ID after `id`, in the form this project writes.
const bump = (root, id) => { const p = parseId(id); return formatId('order', p.number + 1, { code: p.code, phase: null }); };

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
export function placeDrafts(root, { ids, now = new Date(), by = null } = {}) {
  const all = listDrafts(root);
  // Two drafts placed together are numbered in the order they are placed: the order of `ids` when it is given.
  const drafts = ids ? ids.map((i) => all.find((d) => d.id === i)).filter(Boolean) : all;
  const placed = [];
  const numbered = []; // topic → ID, for the topic drafts placed here
  const refused = drafts.filter((d) => !d.ok).map(({ id, problems }) => ({ id, problems }));
  for (const d of drafts.filter((x) => x.ok)) {
    // ORD-0047 part 9: the next free ID at this moment, the project code included; a draft named with a number keeps it.
    const pid = d.topic ? nextOrderId(root) : d.id;
    const targets = { [`.analucia/orders/${pid}.md`]: d.order, [`.analucia/verify/${pid}.json`]: d.verify };
    const before = existsSync(join(root, LOCK_REL)) ? readFileSync(join(root, LOCK_REL)) : null;
    try {
      const hashes = {};
      for (const [to, from] of Object.entries(targets)) {
        mkdirSync(join(root, to, '..'), { recursive: true });
        const raw = readFileSync(join(root, from), 'utf8').replace(/\r\n/g, '\n');
        const bytes = Buffer.from(d.topic ? withId(raw, pid) : raw, 'utf8');
        writeFileSync(join(root, to), bytes);
        hashes[to] = hashLF(bytes);
      }
      writeLock(root, hashes, now);
      admit(root, pid, { now });
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
    const placedText = readFileSync(join(root, `.analucia/orders/${pid}.md`), 'utf8');
    const text = orderKey(placedText, 'decision');
    const rules = businessRulesOf(placedText) ?? [];
    if (d.topic) {
      appendEvent(root, { type: 'operation.logged', actor: by === 'dispatcher' ? 'system' : 'owner', subject: pid, payload: { operation: 'draft_numbered', topic: d.topic, id: pid } }, { now });
      numbered.push({ topic: d.topic, id: pid });
    }
    // AMD-0029 item 5: the decision recorded for the draft by its topic is linked to the ID it got.
    const byTopic = d.topic ? draftDecision(readEvents(root), d.topic, text) : null;
    if (byTopic) {
      appendEvent(root, { type: 'decision.recorded', actor: 'director', subject: pid, payload: { text: byTopic.text, source: byTopic.source ?? null, orders: [pid], draft: d.topic, ...(rules.length ? { business_rules: rules } : {}) } }, { now });
    } else if (by !== 'dispatcher' && (text || rules.length)) {
      // ORD-0046 part 5: the dispatcher places only a draft whose decision is already recorded; it records none as the owner.
      appendEvent(root, { type: 'decision.recorded', actor: 'owner', subject: pid, payload: { text: text ?? `Placement of ${pid}: ${d.title || 'no title'}`, source: `.analucia/orders/${pid}.md`, orders: [pid], ...(rules.length ? { business_rules: rules } : {}) } }, { now });
    }
    for (const from of [d.order, d.verify, `${DRAFTS_REL}/${requestPath(d.id)}`]) rmSync(join(root, from), { force: true });
    placed.push(pid);
  }
  if (placed.length) appendEvent(root, { type: 'operation.logged', actor: by === 'dispatcher' ? 'system' : 'owner', subject: null, payload: { operation: 'drafts_placed', orders: placed, ...(numbered.length ? { numbered } : {}), ...(by ? { by } : {}) } }, { now });
  return { placed, refused, numbered };
}

// The decision the director recorded for a draft by its topic (`aos decision record --draft <topic>`), whose text is
// `text` when the draft carries a `decision:` line (any text when it does not), or null.
export function draftDecision(events, topic, text) {
  const hit = [...events].reverse().find((e) => e.type === 'operation.logged' && e.payload?.operation === 'draft.decision'
    && e.payload.draft === topic && (!text || e.payload.text === text));
  return hit ? { text: hit.payload.text, source: hit.payload.source } : null;
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
    // ORD-0047 part 7: every draft comes with the request it answers; the bootstrap order answers the one of `aos init`.
    writeFileSync(join(draftsDir(root), requestPath(id)), '- Bring the commits that already exist under an order and make the first one that is signed => the whole bootstrap order\n');
  };
  return { item: 'bootstrap_draft', status: wanted ? 'created' : 'unchanged', apply };
}
