// Validator for SPEC-0001 records: order definitions, project.json and the event log.
// Every error is { line, code, message }. Codes are stable; see core/ORDER_FORMAT.md.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { enums, ISO_TS_RE, ORDER_ID_RE, RECORD_ID_RE, SHA256_RE, ULID_RE } from './enums.mjs';
import { movingRefSeverity, projectRoot, readBranches, scanMovingRefs } from './verify-refs.mjs';

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

const err = (line, code, message) => ({ line, code, message });
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPositiveInt = (v) => /^[1-9]\d*$/.test(String(v));
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
const isDate = (v) => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

// ---------- Order definitions ----------

export const ORDER_KEYS = [
  'id', 'title', 'aliases', 'kind', 'created', 'budget_max_minutes', 'budget_max_attempts',
  'depends_on', 'parent', 'amends', 'supersedes', 'absorbs', 'reverts', 'due', 'notes',
  'risk', 'cost_effect', 'rollback', // SPEC-0003 §4
  'workflow', // AMD-0007 §3: an optional template, not a lifecycle
];
export const WORKFLOWS = ['qrspi'];
const REVIEW_DECISIONS = ['approve', 'comment', 'reject']; // AMD-0007 §1
export const ORDER_REQUIRED = ['id', 'title', 'kind', 'created', 'budget_max_minutes', 'budget_max_attempts'];
const LIST_KEYS = new Set(['aliases', 'depends_on', 'absorbs']);

// Front matter: flat `key: value` lines and inline lists `[a, b]` only.
export function parseFrontMatter(text) {
  const lines = text.split(/\r?\n/);
  const errors = [];
  const fields = new Map(); // key -> { value, line }
  if (lines[0] !== '---') {
    return { fields, errors: [err(1, 'E_FRONT_MATTER', 'file must start with a "---" front matter line')], bodyStart: 0 };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i] === '---') { end = i; break; }
  if (end === -1) {
    return { fields, errors: [err(1, 'E_FRONT_MATTER', 'front matter is not closed by a "---" line')], bodyStart: 0 };
  }
  for (let i = 1; i < end; i++) {
    const raw = lines[i];
    if (raw.trim() === '') continue;
    const m = /^([a-z_][a-z0-9_]*):(?:[ \t]+(.*?))?[ \t]*$/.exec(raw);
    if (!m) {
      errors.push(err(i + 1, 'E_FRONT_MATTER', `not a flat "key: value" line: ${JSON.stringify(raw.slice(0, 80))}`));
      continue;
    }
    const [, key, rawValue = ''] = m;
    let value = rawValue;
    if (value.startsWith('[')) {
      if (!value.endsWith(']')) {
        errors.push(err(i + 1, 'E_FRONT_MATTER', `inline list for "${key}" is not closed with "]"`));
        continue;
      }
      const inner = value.slice(1, -1).trim();
      value = inner === '' ? [] : inner.split(',').map((s) => unquote(s.trim()));
    } else {
      value = unquote(value);
    }
    if (fields.has(key)) {
      errors.push(err(i + 1, 'E_DUPLICATE_KEY', `key "${key}" appears more than once`));
      continue;
    }
    fields.set(key, { value, line: i + 1 });
  }
  return { fields, errors, bodyStart: end + 1, lines };
}

function unquote(s) {
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) return s.slice(1, -1);
  return s;
}

// `pinned`: the order was admitted with SPEC-0003 in its pins, so `risk` and `cost_effect` are required (SPEC-0003 §7).
export function validateOrderText(text, fileName, { pinned = false } = {}) {
  const { fields, errors, bodyStart, lines } = parseFrontMatter(text);
  if (bodyStart === 0) return errors;

  // SPEC-0003 §4: risk tier, cost effect, rollback plan.
  const risk = fields.get('risk');
  if (risk && !enums.risk_levels.includes(risk.value)) {
    errors.push(err(risk.line, 'E_RISK_ENUM', `risk ${JSON.stringify(risk.value)} is not one of: ${enums.risk_levels.join(', ')}`));
  }
  const cost = fields.get('cost_effect');
  if (cost) {
    const values = Array.isArray(cost.value) ? cost.value : [cost.value];
    if (!values.length) errors.push(err(cost.line, 'E_COST_EFFECT_ENUM', 'cost_effect needs at least one value'));
    for (const v of values) {
      if (!enums.cost_effects.includes(v)) errors.push(err(cost.line, 'E_COST_EFFECT_ENUM', `cost_effect ${JSON.stringify(v)} is not one of: ${enums.cost_effects.join(', ')}`));
    }
  }
  const rollback = fields.get('rollback');
  if (rollback && (typeof rollback.value !== 'string' || !/^[^/\\][^\\:]*\.md$/.test(rollback.value) || rollback.value.split('/').includes('..'))) {
    errors.push(err(rollback.line, 'E_FIELD_TYPE', '"rollback" must be one relative path to a .md file, for example .analucia/rollback/ORD-0001.md'));
  }
  const workflow = fields.get('workflow');
  if (workflow && !WORKFLOWS.includes(workflow.value)) errors.push(err(workflow.line, 'E_WORKFLOW_ENUM', `workflow ${JSON.stringify(workflow.value)} is not one of: ${WORKFLOWS.join(', ')}`));
  if (risk?.value === 'high' && !rollback) errors.push(err(risk.line, 'E_MISSING_FIELD', '"risk: high" requires a "rollback" plan path'));
  if (pinned) {
    for (const k of ['risk', 'cost_effect']) {
      if (!fields.has(k)) errors.push(err(1, 'E_MISSING_FIELD', `"${k}" is required: this order was admitted with SPEC-0003 in its pins`));
    }
  }

  for (const [key, { line }] of fields) {
    if (key === 'state') errors.push(err(line, 'E_STATE_IN_DEFINITION', 'an order file is a definition; its state is derived from the event log'));
    else if (!ORDER_KEYS.includes(key)) errors.push(err(line, 'E_UNKNOWN_KEY', `key "${key}" is not allowed in an order`));
  }
  for (const key of ORDER_REQUIRED) {
    const f = fields.get(key);
    if (!f || (typeof f.value === 'string' && f.value.trim() === '')) errors.push(err(1, 'E_MISSING_FIELD', `required key "${key}" is missing or empty`));
  }

  const get = (k) => fields.get(k);
  const id = get('id');
  if (id && isNonEmptyString(id.value)) {
    if (typeof id.value !== 'string' || !ORDER_ID_RE.test(id.value)) {
      errors.push(err(id.line, 'E_ID_FORMAT', `id ${JSON.stringify(id.value)} does not match ORD-0000 or ORD-0000.A`));
    } else if (fileName && basename(fileName, '.md') !== id.value) {
      errors.push(err(id.line, 'E_ID_MISMATCH', `id "${id.value}" does not equal the file name "${basename(fileName)}"`));
    }
  } else if (id && Array.isArray(id.value)) {
    errors.push(err(id.line, 'E_ID_FORMAT', 'id must be a single value'));
  }

  const kind = get('kind');
  if (kind && isNonEmptyString(kind.value) && !enums.order_kinds.includes(kind.value)) {
    errors.push(err(kind.line, 'E_KIND_ENUM', `kind ${JSON.stringify(kind.value)} is not one of: ${enums.order_kinds.join(', ')}`));
  }

  for (const k of ['title', 'notes']) {
    const f = get(k);
    if (f && typeof f.value !== 'string') errors.push(err(f.line, 'E_FIELD_TYPE', `"${k}" must be text, not a list`));
  }
  for (const k of ['created', 'due']) {
    const f = get(k);
    if (f && f.value !== '' && !isDate(f.value)) errors.push(err(f.line, 'E_FIELD_TYPE', `"${k}" must be a date YYYY-MM-DD`));
  }
  for (const k of ['budget_max_minutes', 'budget_max_attempts']) {
    const f = get(k);
    if (f && f.value !== '' && (typeof f.value !== 'string' || !isPositiveInt(f.value))) {
      errors.push(err(f.line, 'E_FIELD_TYPE', `"${k}" must be a positive integer`));
    }
  }
  for (const k of LIST_KEYS) {
    const f = get(k);
    if (f && !Array.isArray(f.value)) errors.push(err(f.line, 'E_FIELD_TYPE', `"${k}" must be an inline list [a, b]`));
  }
  for (const k of enums.relation_fields) {
    const f = get(k);
    if (!f) continue;
    const values = Array.isArray(f.value) ? f.value : [f.value];
    if (k === 'parent' && (Array.isArray(f.value) || !ORDER_ID_RE.test(f.value))) {
      errors.push(err(f.line, 'E_REF_FORMAT', '"parent" must be one order ID'));
      continue;
    }
    for (const v of values) {
      if (!RECORD_ID_RE.test(v)) errors.push(err(f.line, 'E_REF_FORMAT', `"${k}" value ${JSON.stringify(v)} is not a record ID`));
    }
  }

  // Body: "## Acceptance criteria" with at least one list item before the next heading.
  let headingLine = -1;
  for (let i = bodyStart; i < lines.length; i++) if (lines[i].trim() === '## Acceptance criteria') { headingLine = i; break; }
  let items = 0;
  if (headingLine !== -1) {
    for (let i = headingLine + 1; i < lines.length; i++) {
      if (/^#{1,2}\s/.test(lines[i])) break;
      if (/^\s*(?:[-*+]|\d+\.)\s+\S/.test(lines[i])) items++;
    }
  }
  if (items === 0) {
    errors.push(err(headingLine === -1 ? 1 : headingLine + 1, 'E_NO_ACCEPTANCE',
      headingLine === -1 ? 'body has no "## Acceptance criteria" section' : '"## Acceptance criteria" has no items'));
  }
  return errors;
}

// ---------- Asks (SPEC-0004 §1) ----------

export const ASK_KEYS = ['id', 'title', 'kind', 'created', 'recommendation', 'options', 'refs'];
export const ASK_REQUIRED = ['id', 'title', 'kind', 'created', 'recommendation'];
export const ASK_ID_RE = /^ASK-\d{4}$/;
export const ASK_BODY_MAX = 600;
export const DEFAULT_DECIDE_OPTIONS = ['approve', 'reject', 'change'];

// The options an ask can be resolved with: its `options`, or the default for `decide`.
export const askOptions = (fields) => {
  const o = fields.get('options')?.value;
  if (Array.isArray(o) && o.length) return o;
  return fields.get('kind')?.value === 'decide' ? DEFAULT_DECIDE_OPTIONS : [];
};

export function validateAskText(text, fileName) {
  const { fields, errors, bodyStart, lines } = parseFrontMatter(text);
  if (bodyStart === 0) return errors;
  for (const [key, { line }] of fields) {
    if (key === 'state') errors.push(err(line, 'E_STATE_IN_DEFINITION', 'an ask file is a definition; its status is derived from the event log'));
    else if (!ASK_KEYS.includes(key)) errors.push(err(line, 'E_UNKNOWN_KEY', `key "${key}" is not allowed in an ask`));
  }
  for (const key of ASK_REQUIRED) {
    const f = fields.get(key);
    if (!f || (typeof f.value === 'string' && f.value.trim() === '')) errors.push(err(1, 'E_MISSING_FIELD', `required key "${key}" is missing or empty`));
  }
  const id = fields.get('id');
  if (id && isNonEmptyString(id.value)) {
    if (!ASK_ID_RE.test(id.value)) errors.push(err(id.line, 'E_ID_FORMAT', `id ${JSON.stringify(id.value)} does not match ASK-0000`));
    else if (fileName && basename(fileName, '.md') !== id.value) errors.push(err(id.line, 'E_ID_MISMATCH', `id "${id.value}" does not equal the file name "${basename(fileName)}"`));
  }
  const kind = fields.get('kind');
  if (kind && isNonEmptyString(kind.value) && !enums.ask_kinds.includes(kind.value)) {
    errors.push(err(kind.line, 'E_ASK_KIND_ENUM', `kind ${JSON.stringify(kind.value)} is not one of: ${enums.ask_kinds.join(', ')}`));
  }
  const created = fields.get('created');
  if (created && created.value !== '' && !isDate(created.value)) errors.push(err(created.line, 'E_FIELD_TYPE', '"created" must be a date YYYY-MM-DD'));
  for (const k of ['title', 'recommendation']) {
    const f = fields.get(k);
    if (f && typeof f.value !== 'string') errors.push(err(f.line, 'E_FIELD_TYPE', `"${k}" must be text, not a list`));
  }
  const options = fields.get('options');
  if (options && (!Array.isArray(options.value) || !options.value.length || options.value.some((o) => !/^[a-z][a-z0-9_]*$/.test(o)))) {
    errors.push(err(options.line, 'E_FIELD_TYPE', '"options" must be a non-empty inline list of lowercase words, for example [approve, reject, change]'));
  }
  if (!options && kind && kind.value !== 'decide' && enums.ask_kinds.includes(kind.value)) {
    errors.push(err(1, 'E_MISSING_FIELD', `"options" is required for kind "${kind.value}" (only "decide" has a default: [${DEFAULT_DECIDE_OPTIONS.join(', ')}])`));
  }
  const refs = fields.get('refs');
  if (refs) {
    if (!Array.isArray(refs.value)) errors.push(err(refs.line, 'E_FIELD_TYPE', '"refs" must be an inline list of record IDs'));
    else for (const r of refs.value) if (!RECORD_ID_RE.test(r)) errors.push(err(refs.line, 'E_REF_FORMAT', `"refs" value ${JSON.stringify(r)} is not a record ID`));
  }
  const body = lines.slice(bodyStart).join('\n').trim();
  if (!body) errors.push(err(bodyStart + 1, 'E_MISSING_FIELD', 'the ask has no question: write it in plain words after the front matter'));
  else if (body.length > ASK_BODY_MAX) errors.push(err(bodyStart + 1, 'E_ASK_TOO_LONG', `the question is ${body.length} characters; the limit is ${ASK_BODY_MAX}`));
  return errors;
}

export const askBody = (text) => {
  const { bodyStart, lines } = parseFrontMatter(text);
  return bodyStart ? lines.slice(bodyStart).join('\n').trim() : '';
};

// ---------- project.json ----------

const PROJECT_KEYS = ['wip_limit', 'budget', 'reversible', 'deploy', 'protected_branches', 'ownership_boundaries', 'locale', 'github_owner', 'budget_monthly_usd', 'budget_currency', 'timezone', 'hosting', 'hosting_where'];
const HOSTING_CHOICES = ['managed', 'own-server', 'already', 'later']; // AMD-0006

function lineOfKey(text, key) {
  const i = text.indexOf(`"${key}"`);
  return i === -1 ? 1 : text.slice(0, i).split('\n').length;
}

function parseJson(text) {
  try {
    return { value: JSON.parse(text) };
  } catch (e) {
    const m = /position (\d+)/.exec(e.message);
    const line = m ? text.slice(0, Number(m[1])).split('\n').length : 1;
    return { error: err(line, 'E_JSON', `invalid JSON: ${e.message}`) };
  }
}

export function validateProjectText(text) {
  const { value: p, error } = parseJson(text);
  if (error) return [error];
  if (!isObject(p)) return [err(1, 'E_FIELD_TYPE', 'project.json must be a JSON object')];
  const errors = [];
  const at = (k) => lineOfKey(text, k);
  for (const k of Object.keys(p)) if (!PROJECT_KEYS.includes(k)) errors.push(err(at(k), 'E_UNKNOWN_KEY', `key "${k}" is not a configuration key of SPEC-0001 §11`));
  if ('wip_limit' in p && !(Number.isInteger(p.wip_limit) && p.wip_limit >= 1)) errors.push(err(at('wip_limit'), 'E_FIELD_TYPE', '"wip_limit" must be an integer >= 1'));
  if ('budget' in p) {
    if (!isObject(p.budget)) errors.push(err(at('budget'), 'E_FIELD_TYPE', '"budget" must be an object'));
    else for (const [k, v] of Object.entries(p.budget)) {
      if (!['max_minutes', 'max_attempts'].includes(k)) errors.push(err(at(k), 'E_UNKNOWN_KEY', `key "budget.${k}" is not allowed`));
      else if (!(Number.isInteger(v) && v >= 1)) errors.push(err(at(k), 'E_FIELD_TYPE', `"budget.${k}" must be an integer >= 1`));
    }
  }
  if ('deploy' in p) {
    if (!isObject(p.deploy)) errors.push(err(at('deploy'), 'E_FIELD_TYPE', '"deploy" must be an object'));
    else for (const [k, v] of Object.entries(p.deploy)) {
      if (k !== 'policy') errors.push(err(at(k), 'E_UNKNOWN_KEY', `key "deploy.${k}" is not allowed`));
      else if (!enums.deploy_policies.includes(v)) errors.push(err(at('policy'), 'E_POLICY_ENUM', `deploy.policy ${JSON.stringify(v)} is not one of: ${enums.deploy_policies.join(', ')}`));
    }
  }
  for (const k of ['reversible', 'protected_branches']) {
    if (k in p && !(Array.isArray(p[k]) && p[k].every((v) => typeof v === 'string'))) errors.push(err(at(k), 'E_FIELD_TYPE', `"${k}" must be a list of strings`));
  }
  if ('ownership_boundaries' in p && !isObject(p.ownership_boundaries)) errors.push(err(at('ownership_boundaries'), 'E_FIELD_TYPE', '"ownership_boundaries" must be an object'));
  if ('locale' in p && !isNonEmptyString(p.locale)) errors.push(err(at('locale'), 'E_FIELD_TYPE', '"locale" must be a non-empty string'));
  if ('github_owner' in p && !isNonEmptyString(p.github_owner)) errors.push(err(at('github_owner'), 'E_FIELD_TYPE', '"github_owner" must be a non-empty string'));
  if ('budget_monthly_usd' in p && !(typeof p.budget_monthly_usd === 'number' && Number.isFinite(p.budget_monthly_usd) && p.budget_monthly_usd >= 0)) {
    errors.push(err(at('budget_monthly_usd'), 'E_FIELD_TYPE', '"budget_monthly_usd" must be a number >= 0'));
  }
  // ORD-0012: the IANA time zone every timestamp is written in (for example America/Lima).
  if ('timezone' in p) {
    let ok = isNonEmptyString(p.timezone);
    if (ok) {
      try { new Intl.DateTimeFormat('en-US', { timeZone: p.timezone }); } catch { ok = false; }
    }
    if (!ok) errors.push(err(at('timezone'), 'E_FIELD_TYPE', '"timezone" must be an IANA time zone, for example "America/Lima"'));
  }
  if ('hosting' in p && !HOSTING_CHOICES.includes(p.hosting)) errors.push(err(at('hosting'), 'E_FIELD_TYPE', `"hosting" must be one of: ${HOSTING_CHOICES.join(', ')}`));
  if ('hosting_where' in p && !(p.hosting === 'already' && isNonEmptyString(p.hosting_where))) errors.push(err(at('hosting_where'), 'E_FIELD_TYPE', '"hosting_where" must be a non-empty string, only with "hosting": "already"'));
  if ('budget_currency' in p && !isNonEmptyString(p.budget_currency)) errors.push(err(at('budget_currency'), 'E_FIELD_TYPE', '"budget_currency" must be a non-empty string'));
  return errors;
}

// ---------- Director files: verify files and the lock (SPEC-0002 §1, §2, §5) ----------

// `movingRefs` ({ severity: 'error' | 'warning', branches }) turns on the ORD-0034 rule: a check may not end a
// git range at a moving ref. Findings carry `severity`; a warning never changes the exit code.
export function validateVerifyText(text, fileName, { movingRefs = null } = {}) {
  const { value: v, error } = parseJson(text);
  if (error) return [error];
  if (!isObject(v)) return [err(1, 'E_FIELD_TYPE', 'a verify file must be a JSON object')];
  const errors = [];
  const at = (k) => lineOfKey(text, k);
  for (const k of Object.keys(v)) if (!['order', 'checks'].includes(k)) errors.push(err(at(k), 'E_UNKNOWN_KEY', `key "${k}" is not allowed in a verify file`));
  if (!('order' in v)) errors.push(err(1, 'E_MISSING_FIELD', 'key "order" is missing'));
  else if (!(typeof v.order === 'string' && ORDER_ID_RE.test(v.order))) errors.push(err(at('order'), 'E_ID_FORMAT', `order ${JSON.stringify(v.order)} is not an order ID`));
  else if (fileName && basename(fileName, '.json') !== v.order) errors.push(err(at('order'), 'E_ID_MISMATCH', `order "${v.order}" does not equal the file name "${basename(fileName)}"`));
  if (!('checks' in v)) errors.push(err(1, 'E_MISSING_FIELD', 'key "checks" is missing'));
  else if (!Array.isArray(v.checks) || v.checks.length === 0) errors.push(err(at('checks'), 'E_FIELD_TYPE', '"checks" must be a non-empty list'));
  else v.checks.forEach((c, i) => {
    const where = `checks[${i}]`;
    if (!isObject(c)) return errors.push(err(at('checks'), 'E_FIELD_TYPE', `${where} must be an object`));
    for (const k of Object.keys(c)) if (!['name', 'run', 'expect_exit'].includes(k)) errors.push(err(at(k), 'E_UNKNOWN_KEY', `${where}: key "${k}" is not allowed`));
    for (const k of ['name', 'run', 'expect_exit']) if (!(k in c)) errors.push(err(at('checks'), 'E_MISSING_FIELD', `${where}: key "${k}" is missing`));
    for (const k of ['name', 'run']) if (k in c && !isNonEmptyString(c[k])) errors.push(err(at(k), 'E_FIELD_TYPE', `${where}: "${k}" must be a non-empty string`));
    if ('expect_exit' in c && !(Number.isInteger(c.expect_exit) && c.expect_exit >= 0 && c.expect_exit <= 255)) {
      errors.push(err(at('expect_exit'), 'E_FIELD_TYPE', `${where}: "expect_exit" must be an integer 0-255`));
    }
    if (movingRefs && isNonEmptyString(c.run)) {
      const found = scanMovingRefs(c.run, { branches: movingRefs.branches });
      if (found.length) {
        const tokens = [...new Set(found.map((f) => `"${f.token}" (${f.command})`))].join(', ');
        const runAt = text.indexOf(JSON.stringify(c.run).slice(1, -1));
        const line = runAt === -1 ? at('checks') : text.slice(0, runAt).split('\n').length;
        errors.push({ ...err(line, 'E_MOVING_REF', `${where} (check ${i + 1}): moving ref ${tokens} as the end of a git range; the check breaks when the ref moves. Use a commit SHA or {order_commit}`), severity: movingRefs.severity });
      }
    }
  });
  return errors;
}

// The event log of a project as objects (unreadable lines skipped); [] without a project.
function readEvents(root) {
  const logFile = root ? join(root, '.analucia', 'events.jsonl') : null;
  if (!logFile || !existsSync(logFile)) return [];
  return readFileSync(logFile, 'utf8').split('\n').filter((l) => l.trim()).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

// A warning is printed but never changes the exit code (ORD-0034 §5).
export const isWarning = (e) => e.severity === 'warning';

export function validateLockText(text) {
  const { value: l, error } = parseJson(text);
  if (error) return [error];
  if (!isObject(l)) return [err(1, 'E_FIELD_TYPE', 'director.lock must be a JSON object')];
  const errors = [];
  const at = (k) => lineOfKey(text, k);
  for (const k of Object.keys(l)) if (!['files', 'written_by', 'date', 'normalization'].includes(k)) errors.push(err(at(k), 'E_UNKNOWN_KEY', `key "${k}" is not allowed in director.lock`));
  if ('written_by' in l && l.written_by !== 'director') errors.push(err(at('written_by'), 'E_FIELD_TYPE', '"written_by" must be "director"'));
  if ('date' in l && !isDate(l.date)) errors.push(err(at('date'), 'E_FIELD_TYPE', '"date" must be a date YYYY-MM-DD'));
  if ('normalization' in l && l.normalization !== 'LF') errors.push(err(at('normalization'), 'E_FIELD_TYPE', '"normalization" must be "LF"'));
  if (!('files' in l)) errors.push(err(1, 'E_MISSING_FIELD', 'key "files" is missing'));
  else if (!isObject(l.files) || Object.keys(l.files).length === 0) errors.push(err(at('files'), 'E_FIELD_TYPE', '"files" must be a non-empty object {path: sha256}'));
  else for (const [p, h] of Object.entries(l.files)) {
    if (!/^[^/\\][^\\:]*$/.test(p) || p.split('/').includes('..')) errors.push(err(at(p), 'E_FIELD_TYPE', `path ${JSON.stringify(p)} must be relative, with "/" separators and no ".."`));
    if (!(typeof h === 'string' && SHA256_RE.test(h))) errors.push(err(at(p), 'E_FIELD_TYPE', `hash for ${JSON.stringify(p)} must be a lowercase sha256 hex string`));
  }
  return errors;
}

// ---------- Events ----------

export const EVENT_KEYS = ['id', 'ts', 'type', 'actor', 'subject', 'payload', 'prev'];
export const OPTIONAL_EVENT_KEYS = ['agent']; // SPEC-0002 §5
export const AGENT_KEYS = ['tool', 'model', 'session'];

// Schema of one event object (no chain check). `line` is used for error positions.
export function validateEvent(e, line = 1) {
  if (!isObject(e)) return [err(line, 'E_JSON', 'an event line must be one JSON object')];
  const errors = [];
  for (const k of Object.keys(e)) if (!EVENT_KEYS.includes(k) && !OPTIONAL_EVENT_KEYS.includes(k)) errors.push(err(line, 'E_UNKNOWN_KEY', `event key "${k}" is not allowed`));
  for (const k of EVENT_KEYS) if (!(k in e)) errors.push(err(line, 'E_MISSING_FIELD', `event key "${k}" is missing`));
  if ('agent' in e) {
    if (!isObject(e.agent)) errors.push(err(line, 'E_FIELD_TYPE', '"agent" must be an object {tool, model, session}'));
    else for (const [k, v] of Object.entries(e.agent)) {
      if (!AGENT_KEYS.includes(k)) errors.push(err(line, 'E_UNKNOWN_KEY', `agent key "${k}" is not allowed`));
      else if (typeof v !== 'string') errors.push(err(line, 'E_FIELD_TYPE', `agent.${k} must be a string`));
    }
  }

  if ('id' in e && !(typeof e.id === 'string' && ULID_RE.test(e.id))) errors.push(err(line, 'E_ID_FORMAT', `event id ${JSON.stringify(e.id)} is not a ULID`));
  if ('ts' in e && !(typeof e.ts === 'string' && ISO_TS_RE.test(e.ts) && !Number.isNaN(Date.parse(e.ts)))) {
    errors.push(err(line, 'E_TS_FORMAT', `ts ${JSON.stringify(e.ts)} is not ISO 8601 with an offset`));
  }
  if ('type' in e && !enums.event_types.includes(e.type)) errors.push(err(line, 'E_TYPE_ENUM', `type ${JSON.stringify(e.type)} is not an event type`));
  if ('actor' in e && !enums.actors.includes(e.actor)) errors.push(err(line, 'E_ACTOR_ENUM', `actor ${JSON.stringify(e.actor)} is not one of: ${enums.actors.join(', ')}`));
  if ('subject' in e && e.subject !== null && !(typeof e.subject === 'string' && RECORD_ID_RE.test(e.subject))) {
    errors.push(err(line, 'E_REF_FORMAT', `subject ${JSON.stringify(e.subject)} is not a record ID or null`));
  }
  if ('prev' in e && e.prev !== null && !(typeof e.prev === 'string' && SHA256_RE.test(e.prev))) {
    errors.push(err(line, 'E_PREV_FORMAT', 'prev must be a lowercase sha256 hex string or null'));
  }
  if ('payload' in e && !isObject(e.payload)) {
    errors.push(err(line, 'E_FIELD_TYPE', 'payload must be a JSON object'));
    return errors;
  }
  if (isObject(e.payload)) errors.push(...validatePayload(e, line));
  return errors;
}

function validatePayload(e, line) {
  const p = e.payload;
  const errors = [];
  const needsOrder = () => {
    if (typeof e.subject !== 'string' || !ORDER_ID_RE.test(e.subject)) errors.push(err(line, 'E_REF_FORMAT', `${e.type} needs an order ID as subject`));
  };
  switch (e.type) {
    case 'order.state_changed': {
      needsOrder();
      for (const k of ['from', 'to']) {
        if (!(k in p)) errors.push(err(line, 'E_MISSING_FIELD', `payload.${k} is missing`));
        else if (!enums.order_states.includes(p[k])) errors.push(err(line, 'E_STATE_ENUM', `payload.${k} ${JSON.stringify(p[k])} is not an order state`));
      }
      if (p.to === 'paused' && !isNonEmptyString(p.reason)) errors.push(err(line, 'E_PAUSED_NO_REASON', 'to "paused" requires payload.reason'));
      // SPEC-0001 §4: a reference (order, ask or decision); SPEC-0002 §3 also allows a reason text.
      if (p.to === 'blocked' && !isNonEmptyString(p.blocked_by)) {
        errors.push(err(line, 'E_BLOCKED_NO_REF', 'to "blocked" requires payload.blocked_by (an ask, order or decision ID, or a reason)'));
      }
      if (p.to === 'superseded' && !(typeof p.superseded_by === 'string' && RECORD_ID_RE.test(p.superseded_by))) {
        errors.push(err(line, 'E_SUPERSEDED_NO_REF', 'to "superseded" requires payload.superseded_by (a record ID)'));
      }
      break;
    }
    case 'run.started':
      needsOrder();
      break;
    case 'run.finished':
      needsOrder();
      if (!enums.run_outcomes.includes(p.outcome)) errors.push(err(line, 'E_OUTCOME_ENUM', `payload.outcome ${JSON.stringify(p.outcome)} is not one of: ${enums.run_outcomes.join(', ')}`));
      break;
    case 'evidence.attached':
      if ('level' in p && !enums.evidence_levels.includes(p.level)) errors.push(err(line, 'E_EVIDENCE_ENUM', `payload.level ${JSON.stringify(p.level)} is not one of: ${enums.evidence_levels.join(', ')}`));
      break;
    case 'order.admitted':
      needsOrder();
      if (!enums.admission_decisions.includes(p.decision)) errors.push(err(line, 'E_DECISION_ENUM', `payload.decision ${JSON.stringify(p.decision)} is not one of: ${enums.admission_decisions.join(', ')}`));
      break;
    case 'ask.opened':
      if (!enums.ask_kinds.includes(p.kind)) errors.push(err(line, 'E_ASK_KIND_ENUM', `payload.kind ${JSON.stringify(p.kind)} is not one of: ${enums.ask_kinds.join(', ')}`));
      break;
    case 'ask.resolved':
      // SPEC-0004 §1: {"decision": "<one of options>", "comment": "<text or empty>", "via": "sheet"}
      if (!isNonEmptyString(p.decision)) errors.push(err(line, 'E_MISSING_FIELD', 'ask.resolved needs payload.decision'));
      if ('comment' in p && typeof p.comment !== 'string') errors.push(err(line, 'E_FIELD_TYPE', 'payload.comment must be text'));
      break;
    case 'role.declared':
      if (!enums.roles.includes(p.role)) errors.push(err(line, 'E_ACTOR_ENUM', `payload.role ${JSON.stringify(p.role)} is not a role`));
      break;
    case 'record.created':
      if ('pins' in p) errors.push(...validatePins(p.pins, line));
      break;
    // AMD-0007 §1: a document registered for the owner's review, and the owner's decision about that content.
    case 'review.requested':
    case 'review.decision':
      if (!isNonEmptyString(p.path)) errors.push(err(line, 'E_MISSING_FIELD', `${e.type} needs payload.path`));
      if (!(typeof p.sha256 === 'string' && SHA256_RE.test(p.sha256))) errors.push(err(line, 'E_FIELD_TYPE', `${e.type} needs payload.sha256 (lowercase sha256 hex)`));
      if (!(typeof p.order === 'string' && RECORD_ID_RE.test(p.order))) errors.push(err(line, 'E_REF_FORMAT', `${e.type} needs payload.order (an order ID)`));
      if (e.type === 'review.decision') {
        if (!REVIEW_DECISIONS.includes(p.decision)) errors.push(err(line, 'E_REVIEW_DECISION', `payload.decision must be one of: ${REVIEW_DECISIONS.join(', ')}`));
        if (typeof p.note !== 'string') errors.push(err(line, 'E_FIELD_TYPE', 'payload.note must be text (empty for approve)'));
        else if (p.decision !== 'approve' && !p.note.trim()) errors.push(err(line, 'E_REVIEW_DECISION', `"${p.decision}" needs a note`));
      }
      break;
    // AMD-0007 §2: one agent window inside (or outside) an order.
    case 'session.start':
    case 'session.end':
      if (!isNonEmptyString(p.session)) errors.push(err(line, 'E_MISSING_FIELD', `${e.type} needs payload.session`));
      if ('order' in p && p.order !== null && !(typeof p.order === 'string' && RECORD_ID_RE.test(p.order))) errors.push(err(line, 'E_REF_FORMAT', 'payload.order must be an order ID or null'));
      if (!isNonEmptyString(p.provider)) errors.push(err(line, 'E_MISSING_FIELD', `${e.type} needs payload.provider`));
      break;
    // ORD-0024 part A: a snapshot of the working tree pushed to backup/<YYYY-MM-DD>.
    case 'backup.pushed':
      if (!(typeof p.branch === 'string' && /^backup\/\d{4}-\d{2}-\d{2}$/.test(p.branch))) errors.push(err(line, 'E_FIELD_TYPE', 'payload.branch must be backup/YYYY-MM-DD'));
      if (!(typeof p.commit === 'string' && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(p.commit))) errors.push(err(line, 'E_FIELD_TYPE', 'payload.commit must be a full git commit id'));
      if (!(Number.isInteger(p.files) && p.files >= 0)) errors.push(err(line, 'E_FIELD_TYPE', 'payload.files must be an integer >= 0'));
      break;
    case 'hosting.chosen':
      if (!HOSTING_CHOICES.includes(p.hosting)) errors.push(err(line, 'E_FIELD_TYPE', `payload.hosting must be one of: ${HOSTING_CHOICES.join(', ')}`));
      if (p.hosting === 'already' && !isNonEmptyString(p.where)) errors.push(err(line, 'E_MISSING_FIELD', 'hosting "already" needs payload.where'));
      break;
    case 'operation.logged':
      errors.push(...validateCostPayload(p, line));
      break;
    default:
      break;
  }
  return errors;
}

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// SPEC-0003 §5: {"pins": {"plugin": "x.y.z", "specs": {"SPEC-0001": "x.y.z", ...}}}
function validatePins(pins, line) {
  if (!isObject(pins)) return [err(line, 'E_FIELD_TYPE', 'payload.pins must be an object {plugin, specs}')];
  const errors = [];
  for (const k of Object.keys(pins)) if (!['plugin', 'specs'].includes(k)) errors.push(err(line, 'E_UNKNOWN_KEY', `pins key "${k}" is not allowed`));
  if (!(typeof pins.plugin === 'string' && SEMVER_RE.test(pins.plugin))) errors.push(err(line, 'E_FIELD_TYPE', 'pins.plugin must be a version x.y.z'));
  if (!isObject(pins.specs)) errors.push(err(line, 'E_FIELD_TYPE', 'pins.specs must be an object {"SPEC-NNNN": "x.y.z"}'));
  else for (const [id, v] of Object.entries(pins.specs)) {
    if (!/^SPEC-\d{4}$/.test(id) || !(typeof v === 'string' && SEMVER_RE.test(v))) errors.push(err(line, 'E_FIELD_TYPE', `pins.specs ${JSON.stringify(id)}: ${JSON.stringify(v)} must be "SPEC-NNNN": "x.y.z"`));
  }
  return errors;
}

// SPEC-0003 §6: cost records and cost alerts travel as operation.logged payloads.
function validateCostPayload(p, line) {
  const errors = [];
  const month = () => {
    if (!(typeof p.month === 'string' && MONTH_RE.test(p.month))) errors.push(err(line, 'E_FIELD_TYPE', 'payload.month must be YYYY-MM'));
  };
  const money = (k) => {
    if (!(typeof p[k] === 'number' && Number.isFinite(p[k]) && p[k] >= 0)) errors.push(err(line, 'E_FIELD_TYPE', `payload.${k} must be a number >= 0`));
  };
  if (p.operation === 'cost') {
    money('usd');
    month();
    if (!isNonEmptyString(p.source)) errors.push(err(line, 'E_MISSING_FIELD', 'a cost record needs payload.source'));
  } else if (p.operation === 'cost_alert') {
    if (!enums.cost_alert_thresholds.includes(p.threshold)) errors.push(err(line, 'E_FIELD_TYPE', `payload.threshold must be one of: ${enums.cost_alert_thresholds.join(', ')}`));
    month();
    money('spent_usd');
    money('budget_usd');
  }
  return errors;
}

// Orders whose record.created pins SPEC-0003 (they must carry risk and cost_effect, SPEC-0003 §7).
export function pinnedOrders(events) {
  return new Set(events.filter((e) => e?.type === 'record.created' && e.payload?.pins?.specs?.['SPEC-0003']).map((e) => e.subject));
}

// Split the log into raw lines (bytes between "\n" terminators). The last line must end with "\n".
export function splitLines(buf) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      lines.push(buf.subarray(start, i));
      start = i + 1;
    }
  }
  const tail = start < buf.length ? buf.subarray(start) : null;
  return { lines, tail };
}

// Full log validation: schema of every line plus the prev hash chain.
export function validateEventsBuffer(buf) {
  const errors = [];
  const { lines, tail } = splitLines(buf);
  const all = tail ? [...lines, tail] : lines;
  if (tail) errors.push(err(all.length, 'E_JSON', 'last line is not terminated by "\\n"'));
  let prevRaw = null;
  all.forEach((raw, i) => {
    const line = i + 1;
    const text = raw.toString('utf8');
    if (text.trim() === '') {
      errors.push(err(line, 'E_JSON', 'empty line'));
    } else {
      let e;
      try {
        e = JSON.parse(text);
      } catch (x) {
        errors.push(err(line, 'E_JSON', `invalid JSON: ${x.message}`));
      }
      if (e !== undefined) {
        errors.push(...validateEvent(e, line));
        if (isObject(e) && 'prev' in e && (e.prev === null || SHA256_RE.test(e.prev))) {
          const expected = prevRaw === null ? null : sha256Hex(prevRaw);
          if (e.prev !== expected) {
            errors.push(err(line, 'E_CHAIN', expected === null ? 'first line must have prev null' : 'prev does not match sha256 of the previous line'));
          }
        }
      }
    }
    prevRaw = raw;
  });
  return errors;
}

// ---------- Files and trees ----------

const toPosix = (p) => p.split(sep).join('/');

export function validateFile(path, display = path, { pinned = new Set(), events, branches } = {}) {
  const name = basename(path);
  let errors;
  // A verify file validated on its own is judged against the project of the current directory.
  const refsFor = () => {
    const root = events && branches ? null : projectRoot(process.cwd());
    const order = basename(name, '.json');
    return { severity: movingRefSeverity(events ?? readEvents(root), order), branches: branches ?? readBranches(root ?? process.cwd()) };
  };
  if (name === 'events.jsonl') errors = validateEventsBuffer(readFileSync(path));
  else if (name === 'project.json') errors = validateProjectText(readFileSync(path, 'utf8'));
  else if (name === 'director.lock') errors = validateLockText(readFileSync(path, 'utf8'));
  else if (/^ORD-.*\.json$/.test(name)) errors = validateVerifyText(readFileSync(path, 'utf8'), name, { movingRefs: refsFor() });
  else if (/^ASK-.*\.md$/.test(name)) errors = validateAskText(readFileSync(path, 'utf8'), name);
  else if (name.endsWith('.md')) errors = validateOrderText(readFileSync(path, 'utf8'), name, { pinned: pinned.has(basename(name, '.md')) });
  else errors = [err(1, 'E_FILE_TYPE', 'not an order (ORD-*.md), ask (ASK-*.md), verify file (ORD-*.json), director.lock, project.json or events.jsonl')];
  return errors.map((e) => ({ file: toPosix(display), ...e }));
}

export function validateTree(root) {
  const out = [];
  const a = join(root, '.analucia');
  const rel = (p) => relative(root, p) || p;
  const ordersDir = join(a, 'orders');
  // Orders admitted with SPEC-0003 pins must carry risk and cost_effect; read the pins from the log.
  const events = readEvents(root);
  const pinned = pinnedOrders(events);
  if (existsSync(ordersDir)) {
    for (const f of readdirSync(ordersDir).filter((f) => f.endsWith('.md')).sort()) out.push(...validateFile(join(ordersDir, f), rel(join(ordersDir, f)), { pinned }));
  }
  const asksDir = join(a, 'asks');
  if (existsSync(asksDir)) {
    for (const f of readdirSync(asksDir).filter((f) => f.endsWith('.md')).sort()) out.push(...validateFile(join(asksDir, f), rel(join(asksDir, f))));
  }
  const verifyDir = join(a, 'verify');
  if (existsSync(verifyDir)) {
    const branches = readBranches(root); // read once per validate
    for (const f of readdirSync(verifyDir).filter((f) => f.endsWith('.json')).sort()) out.push(...validateFile(join(verifyDir, f), rel(join(verifyDir, f)), { events, branches }));
  }
  const lock = join(a, 'director.lock');
  if (existsSync(lock)) out.push(...validateFile(lock, rel(lock)));
  for (const f of ['project.json', 'events.jsonl']) {
    const p = join(a, f);
    if (existsSync(p) && statSync(p).isFile()) out.push(...validateFile(p, rel(p)));
    else out.push({ file: toPosix(rel(p)), ...err(1, 'E_FILE_MISSING', `${f} is missing`) });
  }
  return out;
}

export const formatError = (e) => `${e.file}:${e.line}: ${e.code} ${e.message}`;
