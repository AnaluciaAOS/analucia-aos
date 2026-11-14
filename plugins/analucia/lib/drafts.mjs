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
import { admit } from './lifecycle.mjs';
import { LOCK_REL, hashLF, readLock } from './lock.mjs';
import { appendEvent, logPath, timestampFor } from './log.mjs';
import { replay } from './state.mjs';
import { parseFrontMatter, validateLockText, validateOrderText, validateVerifyText } from './validate.mjs';
import { readBranches } from './verify-refs.mjs';

export const DRAFTS_REL = '.analucia/drafts';
export const DIRECTOR_ENTRY_REL = '.analucia/DIRECTOR.md';
export const BOOTSTRAP_ID = 'ORD-0001';
const ID_RE = /^ORD-\d{4}(?:\.[A-Z])?$/;
const TEMPLATES = fileURLToPath(new URL('../templates/', import.meta.url));
const draftsDir = (root) => join(root, '.analucia', 'drafts');
const git = (root, args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });

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
  const ids = [...new Set(names.map((f) => /^(ORD-[^.]+(?:\.[A-Z])?)\.(?:md|json)$/.exec(f)?.[1]).filter(Boolean))].sort();
  const records = replay(readEvents(root)).records;
  let branches;
  return ids.map((id) => {
    const order = names.includes(`${id}.md`) ? `${DRAFTS_REL}/${id}.md` : null;
    const verify = names.includes(`${id}.json`) ? `${DRAFTS_REL}/${id}.json` : null;
    const problems = [];
    let title = '';
    if (!ID_RE.test(id)) problems.push(`E_ID_FORMAT ${id} is not an order ID (ORD-0000)`);
    if (!order) problems.push(`E_FILE_MISSING the order file ${DRAFTS_REL}/${id}.md is missing`);
    else {
      const text = readFileSync(join(root, order), 'utf8');
      try { title = parseFrontMatter(text).fields.get('title')?.value ?? ''; } catch { /* reported below */ }
      for (const p of validateOrderText(text, `${id}.md`, { pinned: true })) problems.push(`${p.code} ${order}:${p.line}: ${p.message}`);
      let risk;
      try { risk = parseFrontMatter(text).fields.get('risk')?.value; } catch { /* reported above */ }
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
    return { id, order, verify, title, problems, ok: problems.length === 0 };
  });
}

// The next free order ID, over the placed orders, the log and the drafts.
export function nextOrderId(root) {
  const seen = [];
  for (const d of ['orders', 'drafts']) {
    const dir = join(root, '.analucia', d);
    if (existsSync(dir)) for (const f of readdirSync(dir)) seen.push(Number(/^ORD-(\d{4})/.exec(f)?.[1] ?? 0));
  }
  for (const id of Object.keys(replay(readEvents(root)).orders)) seen.push(Number(/^ORD-(\d{4})/.exec(id)?.[1] ?? 0));
  return `ORD-${String(Math.max(0, ...seen) + 1).padStart(4, '0')}`;
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
    if (existsSync(dir) && readdirSync(dir).some((f) => /^ORD-/.test(f))) return false;
  }
  return Object.keys(replay(readEvents(root)).orders).length === 0;
}

// The bootstrap order, already written, as a draft: bring the existing commits under an order and make the first
// push through the guard (OBS-130). The owner's first click places it.
export function bootstrapDraftPlan(root, { now = new Date() } = {}) {
  const wanted = needsBootstrap(root);
  const apply = () => {
    mkdirSync(draftsDir(root), { recursive: true });
    const created = timestampFor(root, now).slice(0, 10);
    writeFileSync(join(draftsDir(root), `${BOOTSTRAP_ID}.md`), render(root, template('bootstrap-order.md')).split('{created}').join(created));
    writeFileSync(join(draftsDir(root), `${BOOTSTRAP_ID}.json`), template('bootstrap-verify.json'));
  };
  return { item: 'bootstrap_draft', status: wanted ? 'created' : 'unchanged', apply };
}
