// Guided onboarding (SPEC-0005 §1–§4): the interview, the answers file, and the configuration it writes.
// Every user-facing text comes from plugins/analucia/i18n/<locale>.json. Everything written to disk is English.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentsMdSync, installGitHooks, secretPatterns } from './guards.mjs';
import { checklistText, hostingTable, parseHosting } from './hosting.mjs';
import { appendEvent, readLog, timestampFor } from './log.mjs';
import { permissionsWrite } from './permissions.mjs';
import { RuleError } from './state.mjs';

export const LOCALES = ['en', 'pt', 'zh-Hans', 'hi', 'es'];
const I18N = fileURLToPath(new URL('../i18n/', import.meta.url));

export function catalog(locale = 'en') {
  if (!LOCALES.includes(locale)) throw new RuleError('E_ANSWER_VALUE', `locale ${JSON.stringify(locale)} is not one of: ${LOCALES.join(', ')}`);
  const load = (l) => JSON.parse(readFileSync(join(I18N, `${l}.json`), 'utf8'));
  const base = load('en').strings;
  const own = load(locale).strings;
  return (key, vars = {}) => (own[key] ?? base[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}

const git = (root, args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });

// GitHub owner suggested by the remote URL (path owner first, then URL user).
export function remoteOwner(root) {
  const url = git(root, ['remote', 'get-url', 'origin']).stdout.trim();
  return /github\.com[/:]([A-Za-z0-9-]+)\//.exec(url)?.[1] ?? /^https?:\/\/([^:@/]+)@/.exec(url)?.[1] ?? null;
}

export const DELIVERED_WHEN_DEFAULT = 'when the checks pass and the owner looked at it';
export const BUDGET_UNKNOWN = 'unknown_alerts_off';

// SPEC-0005 §3. `def(ctx)` returns the safe default; `undefined` means "required, no safe default".
export const QUESTIONS = [
  { key: 'purpose', moment: 1, type: 'text', def: () => undefined },
  { key: 'in_use', moment: 1, type: 'enum', values: ['no', 'yes'], def: () => 'yes' },
  { key: 'end_user_input', moment: 1, type: 'enum', values: ['no', 'yes', 'unsure'], def: () => 'unsure' },
  { key: 'how_verified', moment: 1, type: 'enum', values: ['tests', 'page', 'person'], def: () => 'person' },
  { key: 'never_leaves', moment: 1, type: 'list', def: () => [] },
  { key: 'delivered_when', moment: 1, type: 'text', def: () => DELIVERED_WHEN_DEFAULT },
  { key: 'wip_limit', moment: 1, type: 'int', def: () => 1 },
  { key: 'external_artifacts', moment: 1, type: 'list', def: () => [] },
  { key: 'github_owner', moment: 2, type: 'account', def: (ctx) => ctx.remoteOwner ?? undefined },
  { key: 'cloud_sessions', moment: 2, type: 'enum', values: ['no', 'yes'], def: () => 'no' },
  { key: 'executor_tool', moment: 2, type: 'text', def: () => 'claude-code' },
  { key: 'approve_from', moment: 2, type: 'enum', values: ['terminal', 'sheet'], def: () => 'sheet' },
  { key: 'owner_locale', moment: 2, type: 'enum', values: LOCALES, def: (ctx) => ctx.locale },
  // AMD-0006: where the project will be hosted, before the first order; later is always valid.
  { key: 'hosting', moment: 3, type: 'hosting', def: () => 'later' },
  { key: 'deploy_target', moment: 3, type: 'text', def: () => 'none' },
  { key: 'domain', moment: 3, type: 'text', optional: true, def: () => '' },
  { key: 'budget_monthly_usd', moment: 3, type: 'number', def: () => 0 },
  { key: 'risk_default', moment: 3, type: 'enum', values: ['low', 'medium', 'high'], def: () => 'medium' },
];
const BY_KEY = Object.fromEntries(QUESTIONS.map((q) => [q.key, q]));

const isUnknown = (v) => typeof v === 'string' && v.trim().toLowerCase() === 'unknown';
const allowedText = (q) => (q.values ? q.values.join(', ')
  : { int: 'an integer >= 1', number: 'a number >= 0', list: 'a list of text', account: 'a GitHub account name', hosting: 'managed, own-server, already: <where>, later', text: 'text' }[q.type]);

// One raw answer -> its stored value, or E_ANSWER_VALUE.
export function normalize(q, raw) {
  const bad = () => new RuleError('E_ANSWER_VALUE', `${q.key}: ${JSON.stringify(raw)} is not a valid answer (allowed: ${allowedText(q)})`);
  switch (q.type) {
    case 'enum': {
      const v = String(raw).trim();
      if (!q.values.includes(v)) throw bad();
      return v;
    }
    case 'int': {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) throw bad();
      return n;
    }
    case 'number': {
      const n = typeof raw === 'string' ? Number(raw.trim()) : raw;
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || (typeof raw === 'string' && raw.trim() === '')) throw bad();
      return n;
    }
    case 'list': {
      const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : null;
      if (!items || items.some((x) => typeof x !== 'string')) throw bad();
      return items.map((x) => x.trim()).filter(Boolean);
    }
    case 'hosting': {
      const h = parseHosting(raw);
      return h.choice === 'already' ? `already: ${h.where}` : h.choice;
    }
    case 'account': {
      const v = String(raw).trim();
      if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(v)) throw bad();
      return v;
    }
    default: {
      if (typeof raw !== 'string') throw bad();
      const v = raw.trim();
      if (!v && !q.optional) throw bad();
      return v;
    }
  }
}

export const onboardingPath = (root) => join(root, '.analucia', 'onboarding.json');
export function readOnboarding(root) {
  const p = onboardingPath(root);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : { answers: {} };
}

// Merge the answers given now with the earlier ones. Missing → kept, or the safe default. "unknown" → safe default.
export function resolveAnswers(root, given, { locale, now = new Date() }) {
  // ORD-0029 C: one language field. "locale" and "language" in an answers file are the same field as owner_locale.
  const provided = { ...given };
  for (const alias of ['locale', 'language']) {
    if (alias in provided) {
      if (!('owner_locale' in provided)) provided.owner_locale = provided[alias];
      delete provided[alias];
    }
  }
  for (const k of Object.keys(provided)) if (!BY_KEY[k]) throw new RuleError('E_UNKNOWN_KEY', `"${k}" is not an onboarding question (${QUESTIONS.map((q) => q.key).join(', ')})`);
  const previous = readOnboarding(root).answers ?? {};
  const ctx = { locale, remoteOwner: remoteOwner(root) };
  const at = timestampFor(root, now);
  const answers = {};
  const changed = [];
  const notices = [];
  for (const q of QUESTIONS) {
    const prev = previous[q.key];
    let value;
    let source;
    if (q.key in provided && !isUnknown(provided[q.key])) {
      value = normalize(q, provided[q.key]);
      source = 'owner';
    } else if (!(q.key in provided) && prev) {
      ({ value, source } = prev);
      source = source === 'default' ? 'default' : 'kept';
    } else {
      value = q.def(ctx);
      if (value === undefined) throw new RuleError('E_MISSING_FIELD', `${q.key} is required: it has no safe default`);
      source = 'default';
      notices.push({ key: q.key === 'budget_monthly_usd' ? 'notice.budget_unknown' : 'notice.default', vars: { value: show(value) }, of: q.key });
    }
    const same = prev && JSON.stringify(prev.value) === JSON.stringify(value) && (prev.source === 'default') === (source === 'default');
    answers[q.key] = { value, source: source === 'kept' ? (prev.source ?? 'owner') : source, at: same ? prev.at : at };
    if (!same) changed.push(q.key);
  }
  return { answers, changed, notices, display: Object.fromEntries(QUESTIONS.map((q) => [q.key, sourceOf(q.key, provided, previous, answers)])) };
}
const sourceOf = (key, provided, previous, answers) => (key in provided && !isUnknown(provided[key]) ? 'owner' : (!(key in provided) && previous[key] ? 'kept' : (answers[key].source === 'default' ? 'default' : 'owner')));
const show = (v) => (Array.isArray(v) ? (v.length ? v.join(', ') : '—') : v === '' ? '—' : String(v));

// ---------- configuration (SPEC-0005 §4) ----------

export const ANALUCIA_FOLDERS = ['orders', 'decisions', 'specs', 'observations', 'amendments', 'asks', 'evidence', 'views'];
export const DIRECTOR_SCOPE = ['.analucia/orders/**', '.analucia/amendments/**', '.analucia/verify/**', '.analucia/asks/**', '.analucia/rollback/**', '.analucia/director.lock', 'core/*.md'];
const LF_RULE = '.analucia/** text eol=lf';
const AOS_PATH = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const statusOf = (existed, changed) => (!existed ? 'created' : changed ? 'updated' : 'unchanged');

function projectJsonPlan(root, answers) {
  const p = join(root, '.analucia', 'project.json');
  const existed = existsSync(p);
  const raw = existed ? readFileSync(p, 'utf8') : '';
  const current = existed ? JSON.parse(raw) : {};
  const next = { ...current, wip_limit: answers.wip_limit.value, github_owner: answers.github_owner.value, locale: answers.owner_locale.value };
  // ORD-0012: record the owner's time zone once, so every later timestamp uses it, whatever machine writes it.
  if (!next.timezone) next.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const hosting = parseHosting(answers.hosting.value);
  next.hosting = hosting.choice;
  if (hosting.where) next.hosting_where = hosting.where;
  else delete next.hosting_where;
  if (answers.budget_monthly_usd.source === 'default') delete next.budget_monthly_usd; // unknown → 0 with the alerts off
  else next.budget_monthly_usd = answers.budget_monthly_usd.value;
  const pretty = raw.trim().includes('\n');
  const text = `${pretty ? JSON.stringify(next, null, 2) : JSON.stringify(next)}\n`;
  return { item: 'project_json', status: statusOf(existed, text !== raw), apply: () => writeFileSync(p, text) };
}

function claudeMdPlan(root) {
  const p = join(root, 'CLAUDE.md');
  if (!existsSync(p)) return { item: 'claude_md', status: 'created', apply: () => { if (!existsSync(p)) writeFileSync(p, '@AGENTS.md\n'); } };
  const text = readFileSync(p, 'utf8');
  if (text.replace(/\r\n/g, '\n').split('\n').some((l) => l.trim() === '@AGENTS.md')) return { item: 'claude_md', status: 'unchanged', apply: () => {} };
  // Adoption-safe: the import line is added on top; nothing else is touched (SPEC-0005 §4.3).
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return { item: 'claude_md', status: 'updated', apply: () => writeFileSync(p, `@AGENTS.md${eol}${eol}${text}`) };
}

function gitattributesPlan(root) {
  const p = join(root, '.gitattributes');
  const existed = existsSync(p);
  const text = existed ? readFileSync(p, 'utf8') : '';
  const has = text.replace(/\r\n/g, '\n').split('\n').some((l) => l.trim() === LF_RULE);
  const next = has ? text : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${LF_RULE}\n`;
  return { item: 'gitattributes', status: statusOf(existed, !has), apply: () => { if (!has) writeFileSync(p, next); } };
}

function directorScopePlan(root) {
  let latest = null;
  try {
    latest = readLog(root).events.filter((e) => e.type === 'role.declared' && e.actor === 'director' && Array.isArray(e.payload?.scope)).at(-1) ?? null;
  } catch { /* no log yet */ }
  const covered = latest && DIRECTOR_SCOPE.every((s) => latest.payload.scope.includes(s));
  return {
    item: 'director_scope', status: covered ? 'unchanged' : latest ? 'updated' : 'created',
    apply: () => { if (!covered) appendEvent(root, { type: 'role.declared', actor: 'director', subject: null, payload: { role: 'director', scope: DIRECTOR_SCOPE } }); },
  };
}

// never_leaves entries that look like paths or globs (no spaces) become deny rules.
const denyPaths = (answers) => answers.never_leaves.value.filter((v) => !/\s/.test(v));

export function configPlan(root, answers, { locale }) {
  const items = [];
  const onb = onboardingPath(root);
  const onbText = `${JSON.stringify({ locale, answers, hypotheses: answers.external_artifacts.value.map((path) => ({ path, level: 'hypothesis' })) }, null, 2)}\n`;
  const onbOld = existsSync(onb) ? readFileSync(onb, 'utf8') : null;
  items.push({ item: 'onboarding_json', status: statusOf(onbOld !== null, onbOld !== onbText), apply: () => { mkdirSync(join(root, '.analucia'), { recursive: true }); writeFileSync(onb, onbText); } });
  const missing = ANALUCIA_FOLDERS.filter((f) => !existsSync(join(root, '.analucia', f)));
  items.push({ item: 'folders', status: missing.length === ANALUCIA_FOLDERS.length ? 'created' : missing.length ? 'updated' : 'unchanged', apply: () => missing.forEach((f) => mkdirSync(join(root, '.analucia', f), { recursive: true })) });
  items.push(projectJsonPlan(root, answers));
  const agents = agentsMdSync(root, { dryRun: true });
  items.push({ item: 'agents_md', status: agents.created ? 'created' : agents.changed ? 'updated' : 'unchanged', apply: () => agentsMdSync(root) });
  items.push(claudeMdPlan(root));
  const perm = { profile: answers.risk_default.value, extraDeny: denyPaths(answers) };
  const pw = permissionsWrite(root, { dryRun: true, ...perm });
  items.push({ item: 'permissions', status: pw.created ? 'created' : pw.changed ? 'updated' : 'unchanged', apply: () => permissionsWrite(root, perm) });
  const isRepo = git(root, ['rev-parse', '--is-inside-work-tree']).stdout.trim() === 'true';
  if (isRepo) {
    const gh = installGitHooks(root, AOS_PATH, { dryRun: true });
    items.push({ item: 'git_hooks', status: gh.created ? 'created' : gh.changed ? 'updated' : 'unchanged', apply: () => installGitHooks(root, AOS_PATH) });
  } else {
    items.push({ item: 'git_hooks', status: 'skipped', apply: () => {} });
  }
  items.push(gitattributesPlan(root));
  items.push(directorScopePlan(root));
  return items;
}

// External artifacts may carry credentials: name the file and line, never the value (Q-96, Q-101).
export function artifactSecrets(root, paths) {
  const found = [];
  const patterns = secretPatterns();
  for (const rel of paths) {
    const p = join(root, rel);
    if (!existsSync(p)) continue;
    let text;
    try { text = readFileSync(p, 'utf8'); } catch { continue; }
    text.split(/\r?\n/).forEach((line, i) => {
      for (const pat of patterns) if (pat.re.test(line)) found.push({ path: rel, line: i + 1, pattern: pat.name });
    });
  }
  return found;
}

// wizard: the owner already reviewed the answers in the wizard summary, so the plan lists only what will be written,
// and it carries no hosting price table (ORD-0029 C; the table stays for --answers and --hosting, AMD-0006).
export function planText(t, resolved, items, secrets, { now = new Date(), wizard = false } = {}) {
  const out = [t('plan.title'), ''];
  if (!wizard) {
    out.push(t('plan.answers'));
    for (const q of QUESTIONS) {
      const a = resolved.answers[q.key];
      out.push(`  ${q.key}: ${show(a.value)}  (${t(`source.${resolved.display[q.key]}`)})`);
    }
    const notes = resolved.notices.map((n) => `  - ${n.of}: ${t(n.key, n.vars)}`);
    if (notes.length) out.push('', ...notes);
    out.push('');
  }
  out.push(t('plan.config'));
  for (const i of items) out.push(`  ${t(`item.${i.item}`)}: ${t(`status.${i.status}`)}`);
  for (const s of secrets) out.push('', `  ! ${t('notice.secret_in_artifact', s)}`);
  if (!wizard) out.push('', hostingTable(t, { now }));
  if (parseHosting(resolved.answers.hosting.value).choice === 'own-server') out.push('', checklistText(t));
  return out.join('\n');
}

// --answers <file> [--dry-run], or the interactive interview (provided = what the owner typed).
export async function runInit(root, { provided, locale, dryRun = false, isTTY = false, ask, out = () => {}, now = new Date(), wizard = false, onConfirmed = () => {} }) {
  if (!dryRun && !isTTY) throw new RuleError('E_OWNER_TTY', 'onboarding writes the project configuration: the owner runs "aos init" in their own terminal (an agent may prepare --answers and run --dry-run)');
  const resolved = resolveAnswers(root, provided, { locale, now });
  // One language field (OBS-103): the answer owner_locale sets the plan, the CONFIRM prompt and onboarding.json.
  const language = resolved.answers.owner_locale.value;
  const t = catalog(language);
  const items = configPlan(root, resolved.answers, { locale: language });
  const secrets = artifactSecrets(root, resolved.answers.external_artifacts.value);
  out(planText(t, resolved, items, secrets, { now, wizard }));
  if (dryRun) {
    out(`\n${t('plan.dry_run')}`);
    return { applied: false, resolved, items };
  }
  const answer = await ask(`\n${t('plan.confirm')}`);
  if (answer.trim() !== 'CONFIRM') throw new RuleError('E_NOT_CONFIRMED', t('plan.not_confirmed'));
  onConfirmed(); // ORD-0033 B.2: the first write of aos init comes after CONFIRM (onboarding.started, then the plan)
  for (const i of items) if (i.status !== 'unchanged') i.apply();
  if (resolved.changed.length) {
    appendEvent(root, { type: 'operation.logged', actor: 'owner', subject: null, payload: { operation: 'onboarding', changed: resolved.changed } }, { now });
  }
  if (resolved.changed.includes('hosting')) {
    const h = parseHosting(resolved.answers.hosting.value);
    appendEvent(root, { type: 'hosting.chosen', actor: 'owner', subject: null, payload: h.where ? { hosting: h.choice, where: h.where } : { hosting: h.choice } }, { now });
  }
  out(t('plan.applied'));
  return { applied: true, resolved, items };
}

// ---------- the owner's first hour (AMD-0004) ----------

// A brand-new project has no log yet: create an empty one so the first events can be appended.
function ensureLog(root) {
  const p = join(root, '.analucia', 'events.jsonl');
  if (!existsSync(p)) {
    mkdirSync(join(root, '.analucia'), { recursive: true });
    writeFileSync(p, '');
  }
}

// Appended when the owner approves the plan (ORD-0033 B.2: aos init writes nothing before CONFIRM). startedAt is
// when the interview (or a real --answers apply) began: kept in the payload, so the first hour (AMD-0004) still
// starts with the interview.
export function onboardingStarted(root, { now = new Date(), startedAt } = {}) {
  ensureLog(root);
  const payload = startedAt ? { started_at: timestampFor(root, startedAt) } : {};
  return appendEvent(root, { type: 'onboarding.started', actor: 'owner', subject: null, payload }, { now });
}

// When the setup checks finish, with how many passed.
export function onboardingCompleted(root, results, { now = new Date() } = {}) {
  ensureLog(root);
  const count = (s) => results.filter((r) => r.status === s).length;
  return appendEvent(root, {
    type: 'onboarding.completed', actor: 'owner', subject: null,
    payload: { checks_passed: count('PASS'), checks_warned: count('WARN'), checks_failed: count('FAIL'), checks_total: results.length },
  }, { now });
}

// The interactive interview: asks what is missing, plus what the owner chooses to change (SPEC-0005 §1).
export async function interview(root, { locale, ask, out }) {
  const t = catalog(locale);
  const previous = readOnboarding(root).answers ?? {};
  out(t('intro'));
  let change = new Set();
  if (Object.keys(previous).length) {
    const picked = (await ask(`\n${t('prompt.change')}\n${t('prompt.answer')}`)).split(',').map((s) => s.trim()).filter(Boolean);
    for (const k of picked) if (BY_KEY[k]) change.add(k);
  }
  const provided = {};
  let moment = 0;
  for (const q of QUESTIONS) {
    if (previous[q.key] && !change.has(q.key)) continue;
    if (q.moment !== moment) { moment = q.moment; out(`\n${t(`moment.${moment}`)}`); }
    for (;;) {
      const lines = [`\n${t(`q.${q.key}`)}`, `  ${t(`h.${q.key}`)}`];
      if (previous[q.key]) lines.push(`  ${t('prompt.current', { value: show(previous[q.key].value) })}`);
      const raw = await ask(`${lines.join('\n')}\n${t('prompt.answer')}`);
      if (raw.trim() === '') {
        if (previous[q.key]) break;
        if (q.def({ locale, remoteOwner: remoteOwner(root) }) === undefined) { out(t('notice.required', { key: q.key })); continue; }
        provided[q.key] = q.type === 'list' ? [] : q.optional ? '' : 'unknown';
        break;
      }
      if (isUnknown(raw)) { provided[q.key] = 'unknown'; break; }
      try {
        normalize(q, raw);
        provided[q.key] = raw;
        break;
      } catch {
        out(t('prompt.invalid', { allowed: allowedText(q) }));
      }
    }
  }
  return provided;
}
