// Lifecycle commands (SPEC-0002 §3, SPEC-0003 §4–§5): admit, run start, run finish, verify, close.
// Every state change goes through appendEvent, so the ORD-0003 transition rules still apply.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enums } from './enums.mjs';
import { openRunOf, removeHandoff } from './handoff.mjs';
import { checkLock, hashLF, readLock } from './lock.mjs';
import { appendEvent, readLog, timestampFor } from './log.mjs';
import { declaredDirector } from './session-names.mjs';
import { aosCommand } from './cli.mjs';
import { remainingLine, scratchCheck } from './scratch.mjs';
import { missingLine, reportCheck } from './report.mjs';
import { pushAccountProblems, pushAccountRemotes, pushGuardStatus } from './guards.mjs';
import { RuleError, replay } from './state.mjs';
import { parseFrontMatter, validateOrderText, validateVerifyText } from './validate.mjs';
import { baselineRel, testsBaseline } from './not-worse.mjs';
import { readProject } from './cost.mjs';
import { scanFiles } from './denylist.mjs';
import { ORDER_COMMIT, readBranches, resolveOrderCommit, resolveRun, usesOrderCommit } from './verify-refs.mjs';
import { renderedNext } from './errors.mjs';

const orderPath = (root, id) => join(root, '.analucia', 'orders', `${id}.md`);
const PLUGIN_JSON = fileURLToPath(new URL('../.claude-plugin/plugin.json', import.meta.url));
export const currentPluginVersion = () => JSON.parse(readFileSync(PLUGIN_JSON, 'utf8')).version;

function orderFields(root, id) {
  const p = orderPath(root, id);
  if (!existsSync(p)) throw new RuleError('E_NO_ORDER', `no order file .analucia/orders/${id}.md: the executor runs only orders that exist`);
  return parseFrontMatter(readFileSync(p, 'utf8')).fields;
}

// Risk tier of an order (SPEC-0003 §7):
// - no pins in its record.created (orders admitted before SPEC-0003): tier null, SPEC-0002 rules;
// - pinned: its `risk`; a missing `risk` is treated as `high` (the safest default, Q-06), with a warning.
export function riskTier(root, id, events) {
  const created = events.find((e) => e.type === 'record.created' && e.subject === id);
  const pins = created?.payload?.pins ?? null;
  if (!pins) return { tier: null, pins: null, warning: null };
  const risk = orderFields(root, id).get('risk')?.value;
  if (enums.risk_levels.includes(risk)) return { tier: risk, pins, warning: null };
  return { tier: 'high', pins, warning: `${id} has no valid "risk" key; treated as high (SPEC-0003 §7)` };
}

// Versions of the core specs, read from the `id:` and `version:` front-matter lines of core/*.md.
export function specVersions(root) {
  const dir = join(root, 'core');
  const out = {};
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.md')).sort()) {
    const text = readFileSync(join(dir, f), 'utf8');
    const id = /^id:\s*(SPEC-\d{4})\s*$/m.exec(text)?.[1];
    const version = /^version:\s*(\d+\.\d+\.\d+)\b/m.exec(text)?.[1];
    if (id && version) out[id] = version;
  }
  return out;
}

// ---------- preflight (ORD-0041 part 4, AMD-0015 §4) ----------

// The verify file of an order: the placed one, or the draft's while the order is still a draft. Null when neither exists.
export function verifyFileOf(root, id) {
  for (const rel of [`.analucia/verify/${id}.json`, `.analucia/drafts/${id}.json`]) if (existsSync(join(root, rel))) return rel;
  return null;
}

// Runs the `preflight` checks of the order's verify file on the tree as it is. It changes no state and writes no
// event: only its output, under the order's evidence folder. Returns { has: false } when the verify file has no
// preflight, else { has: true, results, passed, failed: [names], evidence }.
export function runPreflight(root, id, { now = new Date(), onCheck = () => {}, optional = false } = {}) {
  const rel = verifyFileOf(root, id);
  // An order admitted or started without a verify file has no start condition to try: as before this part.
  if (!rel && optional) return { has: false, file: null };
  if (!rel) throw new RuleError('E_FILE_MISSING', `${id} has no verify file (.analucia/verify/${id}.json, or .analucia/drafts/${id}.json for a draft)`);
  const text = readFileSync(join(root, rel), 'utf8');
  const schema = validateVerifyText(text, `${id}.json`);
  if (schema.length) throw new RuleError(schema[0].code, `${rel}: ${schema[0].message}`);
  const { preflight = [] } = JSON.parse(text);
  // ORD-0042 part 5: every preflight includes the built-in check "push account", one per remote the order may push
  // to; a failure names the one command that fixes it.
  const wrong = pushAccountProblems(root);
  const remotes = pushAccountRemotes(root);
  const builtin = remotes.map((remote) => {
    const p = wrong.find((w) => w.remote === remote);
    return { name: `push account (${remote})`, passed: !p, detail: p ? `remote "${remote}": URL user ${JSON.stringify(p.user)}, credential user ${JSON.stringify(p.cred)}, the account of this remote is "${p.account}"; fix it with: ${aosCommand()} install-git-hooks` : `remote "${remote}": URL user and credential user are the account of the remote` };
  });
  // ORD-0043 part 12: and the built-in check "push guard installed": the guard itself is where git looks for it.
  const guard = pushGuardStatus(root);
  if (guard) builtin.push({ name: 'push guard installed', passed: guard.passed, detail: guard.detail });
  // ORD-0047 part 3 (OBS-205): a project that names its tests (project.json "tests") has its baseline recorded by the
  // preflight, on the tree as it is before the work: once per order (an existing baseline is never overwritten).
  if (readProject(root)?.tests && !existsSync(join(root, baselineRel(id)))) {
    try {
      const b = testsBaseline(root, id, { now });
      builtin.push({ name: 'tests baseline', passed: true, detail: `${b.ran} test(s) recorded in ${b.path}; ${b.failing.length} already failing` });
    } catch (x) {
      builtin.push({ name: 'tests baseline', passed: false, detail: `the tests of the project did not run: ${x.message}` });
    }
  }
  if (!preflight.length && !builtin.length) return { has: false, file: rel };
  const bash = findBash();
  const report = [`# aos preflight ${id} at ${timestampFor(root, now)}`, '', `verify file: ${rel}`, `shell: ${bash}`, ''];
  const first = builtin.map((b) => {
    const result = { name: b.name, exit: b.passed ? 0 : 1, expect_exit: 0, passed: b.passed, detail: b.detail };
    onCheck(result);
    report.push(`## built-in: ${b.name}`, '', b.detail, `${b.passed ? 'PASS' : 'FAIL'}`, '');
    return result;
  });
  const own = preflight.map((c, i) => {
    const r = spawnSync(bash, ['-c', c.run], { cwd: root, encoding: 'utf8', timeout: 15 * 60000, maxBuffer: 64 * 1024 * 1024 });
    const exit = r.status ?? -1;
    const result = { name: c.name, exit, expect_exit: c.expect_exit, passed: exit === c.expect_exit };
    onCheck(result);
    report.push(`## preflight ${i + 1}: ${c.name}`, '', `$ ${c.run}`, `exit ${exit} (expected ${c.expect_exit}): ${result.passed ? 'PASS' : 'FAIL'}`, '', '```', `${(r.stdout ?? '') + (r.stderr ?? '') + (r.error ? `\n${r.error.message}` : '')}`.trimEnd(), '```', '');
    return result;
  });
  const results = [...first, ...own];
  const failed = results.filter((r) => !r.passed).map((r) => r.name);
  report.push(`result: ${failed.length ? `FAILED (${failed.length} of ${results.length})` : `all ${results.length} preflight checks passed`}`);
  const dir = join(root, '.analucia', 'evidence', id);
  mkdirSync(dir, { recursive: true });
  const n = readdirSync(dir).filter((f) => /^preflight-\d+\.txt$/.test(f)).length + 1;
  const evidence = `.analucia/evidence/${id}/preflight-${String(n).padStart(2, '0')}.txt`;
  writeFileSync(join(root, evidence), `${report.join('\n')}\n`);
  return { has: true, file: rel, results, passed: failed.length === 0, failed, evidence };
}

// For admit and run start: the preflight must pass, else E_PREFLIGHT_FAILED with the failing checks.
export function requirePreflight(root, id, opts = {}) {
  const p = runPreflight(root, id, opts);
  if (p.has && !p.passed) {
    throw Object.assign(new RuleError('E_PREFLIGHT_FAILED', `${p.failed.length} of ${p.results.length} preflight check(s) failed: ${p.failed.join(', ')}; see ${p.evidence}. Nothing was started or recorded`), { preflight: p });
  }
  return p;
}

// aos admit (SPEC-0003 §5): the director admits a locked, valid order and pins the versions it is governed by.
export function admit(root, id, { now = new Date(), pluginVersion = currentPluginVersion() } = {}) {
  const rel = `.analucia/orders/${id}.md`;
  const p = orderPath(root, id);
  if (!existsSync(p)) throw new RuleError('E_NO_ORDER', `no order file ${rel}; the director writes it first`);
  const expected = readLock(root)?.files?.[rel];
  if (!expected) throw new RuleError('E_NOT_LOCKED', `${rel} is not listed in .analucia/director.lock; the director adds it (with its sha256) before admitting`);
  if (hashLF(readFileSync(p)) !== expected) throw new RuleError('E_DIRECTOR_FILE_CHANGED', `${rel} differs from its hash in .analucia/director.lock`);
  const problems = validateOrderText(readFileSync(p, 'utf8'), `${id}.md`, { pinned: true });
  if (problems.length) throw new RuleError(problems[0].code, `${rel}:${problems[0].line}: ${problems[0].message}`);
  // ORD-0034 §6: a verify file whose checks end a git range at a moving ref is refused (an error: the order has no record yet).
  const vrel = `.analucia/verify/${id}.json`;
  if (existsSync(join(root, vrel))) {
    const refs = validateVerifyText(readFileSync(join(root, vrel), 'utf8'), `${id}.json`, { movingRefs: { severity: 'error', branches: readBranches(root) }, grepAscii: true });
    if (refs.length) throw new RuleError(refs[0].code, `${vrel}:${refs[0].line}: ${refs[0].message}`);
  }
  // ORD-0047 part 13 (OBS-191): the release guard's matcher over the order's own files, tracked or not.
  const own = [rel, vrel, orderFields(root, id).get('rollback')?.value ?? `.analucia/rollback/${id}.md`, `.analucia/drafts/${id}.request.md`];
  const deny = scanFiles(root, readProject(root) ?? {}, own);
  if (deny.missing) throw new RuleError('E_DENYLIST_FILE', `admission refused: .analucia/project.json names a release_denylist and ${deny.missing}`);
  if (deny.hits.length) throw new RuleError('E_DENYLIST_FILE', `admission refused: a forbidden name is in ${deny.hits.join(', ')}`);
  const { events } = readLog(root);
  if (replay(events).records[id]) throw new RuleError('E_RECORD_EXISTS', `${id} already exists in the event log`);
  // ORD-0041 part 4 (AMD-0015 §4): the start conditions of the order are tried before it is admitted.
  const preflight = requirePreflight(root, id, { now, optional: true });
  const pins = { plugin: pluginVersion, specs: specVersions(root) };
  appendEvent(root, { type: 'record.created', actor: 'director', subject: id, payload: { pins } }, { now });
  appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: id, payload: { from: 'draft', to: 'ready' } }, { now });
  appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: id, payload: { from: 'ready', to: 'queued' } }, { now });
  return { pins, preflight };
}

// High risk: the order names .analucia/rollback/ORD-NNNN.md, the file exists and the lock lists it.
function checkRollback(root, id) {
  const want = `.analucia/rollback/${id}.md`;
  const named = orderFields(root, id).get('rollback')?.value;
  if (named !== want) throw new RuleError('E_NO_ROLLBACK', `${id} is high risk: its "rollback" key must be ${want} (found ${JSON.stringify(named ?? null)})`);
  if (!existsSync(join(root, want))) throw new RuleError('E_NO_ROLLBACK', `${id} is high risk and its rollback plan ${want} does not exist`);
  const expected = readLock(root)?.files?.[want];
  if (!expected) throw new RuleError('E_NO_ROLLBACK', `${id} is high risk and ${want} is not listed in .analucia/director.lock`);
  if (hashLF(readFileSync(join(root, want))) !== expected) throw new RuleError('E_DIRECTOR_FILE_CHANGED', `${want} differs from its hash in .analucia/director.lock`);
}

export function readOrderBudget(root, id) {
  const p = orderPath(root, id);
  if (!existsSync(p)) throw new RuleError('E_NO_ORDER', `no order file .analucia/orders/${id}.md: the executor runs only orders that exist`);
  const { fields } = parseFrontMatter(readFileSync(p, 'utf8'));
  return {
    max_minutes: Number(fields.get('budget_max_minutes')?.value),
    max_attempts: Number(fields.get('budget_max_attempts')?.value),
  };
}

const runsOf = (events, id) => events.filter((e) => e.subject === id && e.type === 'run.started');
const openRun = (events, id) => {
  let open = null;
  for (const e of events) {
    if (e.subject !== id) continue;
    if (e.type === 'run.started') open = e;
    if (e.type === 'run.finished') open = null;
  }
  return open;
};

// ORD-0041 part 5 (AMD-0015 §5): a session that declared the role director never owns a run and cannot start one.
function refuseDirectorRun(root, agent, events, what) {
  if (agent?.session && declaredDirector(root, agent.session, events)) {
    throw new RuleError('E_DIRECTOR_RUN', `this session declared the role director and cannot ${what}: a director never executes an order. Nothing was started`);
  }
}

export function runStart(root, id, { now = new Date(), agent } = {}) {
  const budget = readOrderBudget(root, id);
  const { events } = readLog(root);
  refuseDirectorRun(root, agent, events, 'start a run');
  const order = replay(events).orders[id];
  if (!order) throw new RuleError('E_TRANSITION', `${id} has no record.created event; the director must create and queue it`);
  // ORD-0043 part 6: an order the owner sent back for corrections is active with no open run; its next run starts
  // here, with no second transition, within the same attempt budget and after the preflight.
  const rework = order.state === 'active' && !openRun(events, id);
  if (order.state !== 'queued' && !rework) throw new RuleError('E_TRANSITION', `${id} is "${order.state}"; "run start" needs "queued"`);
  const attempts = runsOf(events, id).length;
  if (attempts >= budget.max_attempts) {
    appendEvent(root, {
      type: 'run.finished', actor: 'executor', subject: id, agent,
      payload: { run: attempts + 1, outcome: 'budget_exhausted', refused_start: true, budget },
    }, { now });
    throw new RuleError('E_BUDGET', `${id} already used ${attempts} of ${budget.max_attempts} attempts; recorded outcome budget_exhausted. The director decides what happens next (amendment or new order)`);
  }
  const { tier, pins, warning } = riskTier(root, id, events);
  const warnings = warning ? [warning] : [];
  if (tier === 'high') checkRollback(root, id);
  const payload = { run: attempts + 1, budget };
  const current = currentPluginVersion();
  if (pins && pins.plugin !== current) {
    payload.version_skew = { pinned: pins.plugin, current };
    warnings.push(`${id} was admitted with plugin ${pins.plugin}; running with ${current}. It stays governed by its pins (SPEC-0003 §5)`);
  }
  // ORD-0041 part 4 (AMD-0015 §4): the preflight runs again. When a check fails nothing starts: no run.started is
  // written and no attempt is consumed, so a missing prerequisite never costs an attempt.
  requirePreflight(root, id, { now, optional: true });
  if (rework) payload.rework = true;
  else appendEvent(root, { type: 'order.state_changed', actor: 'executor', subject: id, agent, payload: { from: 'queued', to: 'active' } }, { now });
  const { line } = appendEvent(root, { type: 'run.started', actor: 'executor', subject: id, agent, payload }, { now });
  return { run: attempts + 1, budget, line, tier, warnings, rework };
}

// AMD-0005 §2: the executor pauses an active order. The open run ends with outcome `blocked`, then the order
// moves `active -> paused` with the reason (required: E_PAUSED_NO_REASON).
export function pauseOrder(root, id, { reason, now = new Date(), agent } = {}) {
  if (!reason || !String(reason).trim()) throw new RuleError('E_PAUSED_NO_REASON', `"aos pause ${id}" needs --reason "<why>"`);
  readOrderBudget(root, id); // E_NO_ORDER when the order file is missing
  const { events } = readLog(root);
  const order = replay(events).orders[id];
  const started = openRun(events, id);
  if (!order || order.state !== 'active' || !started) {
    throw new RuleError('E_TRANSITION', `${id} is "${order?.state ?? 'unknown'}" with ${started ? 'an' : 'no'} open run; only an active order with an open run can be paused`);
  }
  appendEvent(root, { type: 'run.finished', actor: 'executor', subject: id, agent, payload: { run: started.payload.run, outcome: 'blocked', paused: true, reason: String(reason) } }, { now });
  appendEvent(root, { type: 'order.state_changed', actor: 'executor', subject: id, agent, payload: { from: 'active', to: 'paused', reason: String(reason) } }, { now });
  return { run: started.payload.run };
}

// AMD-0005 §2: back from `paused` to `active` with a new run, inside the order's attempt budget (each run is an
// attempt, so a resume beyond budget_max_attempts is refused with E_BUDGET and recorded, as at run start).
// ORD-0042 part 2: why the block of a blocked order has ended, or null. It has ended when an amendment to the order
// was recorded after the block (record.amended), or when the ask it waited for was resolved by the owner.
export function blockEnded(events, id) {
  const state = replay(events);
  const order = state.orders[id];
  if (!order || order.state !== 'blocked') return null;
  let since = -1;
  events.forEach((e, i) => { if (e.subject === id && e.type === 'order.state_changed' && e.payload?.to === 'blocked') since = i; });
  const amended = events.slice(since + 1).filter((e) => e.subject === id && e.type === 'record.amended').at(-1);
  if (amended) return { by: 'amendment', ref: amended.payload?.amendment ?? null };
  const ask = order.blocked_by ? state.asks[order.blocked_by] : null;
  if (ask && ask.status === 'resolved') return { by: 'ask', ref: order.blocked_by };
  return null;
}

// The latest recorded preflight of an order: 'passed', 'failed' (with its evidence file) or null when none was run.
// Read from the files `aos preflight`, `aos admit` and `aos run start` leave under the order's evidence folder.
export function lastPreflight(root, id) {
  const dir = join(root, '.analucia', 'evidence', id);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => /^preflight-\d+\.txt$/.test(f)).sort();
  if (!files.length) return null;
  const evidence = `.analucia/evidence/${id}/${files.at(-1)}`;
  const result = /^result: (.*)$/m.exec(readFileSync(join(root, evidence), 'utf8'))?.[1] ?? '';
  return { result: result.startsWith('all ') ? 'passed' : 'failed', evidence };
}

export function resumeOrder(root, id, { now = new Date(), agent, reason } = {}) {
  const budget = readOrderBudget(root, id);
  const { events } = readLog(root);
  refuseDirectorRun(root, agent, events, 'resume a run');
  const order = replay(events).orders[id];
  // ORD-0042 part 2 (SPEC-0002 as amended by the order): resume-order leaves `blocked` as well as `paused`, when the
  // block has ended. It writes the transition the state table already allows; nobody writes it by hand again.
  // ORD-0043 part 3: with neither automatic condition, a written reason says why the block has ended (the owner did
  // what the order waited for and nothing in the log says so).
  const ended = blockEnded(events, id);
  const said = typeof reason === 'string' && reason.trim() ? reason.trim() : null;
  if (order?.state === 'blocked' && !ended && !said) {
    throw new RuleError('E_TRANSITION', `${id} is "blocked" (${order.reason ?? order.blocked_by ?? 'no reason recorded'}) and nothing in the log says the block has ended. When what it waits for is done, say so: aos resume-order ${id} --reason "<why the block has ended>" (also: aos unblock ${id} --reason "…"). It also ends by itself when the director records an amendment to the order, or when the owner answers the ask it waits for (${order.blocked_by ?? 'none'})`);
  }
  if (!order || !['paused', 'blocked'].includes(order.state)) throw new RuleError('E_TRANSITION', `${id} is "${order?.state ?? 'unknown'}"; "aos resume-order" needs "paused", or "blocked" with the block ended (an amendment, an answered ask, or --reason "<why the block has ended>")`);
  const from = order.state;
  const byReason = from === 'blocked' && !ended;
  const why = ended ? `the block ended (${ended.by === 'ask' ? `${ended.ref} answered` : `amendment ${ended.ref ?? 'recorded'}`}); resumed by the executor`
    : byReason ? `the block ended: ${said}; resumed by the executor` : 'resumed by the executor';
  const attempts = runsOf(events, id).length;
  if (attempts >= budget.max_attempts) {
    appendEvent(root, { type: 'run.finished', actor: 'executor', subject: id, agent, payload: { run: attempts + 1, outcome: 'budget_exhausted', refused_start: true, budget } }, { now });
    throw new RuleError('E_BUDGET', `${id} already used ${attempts} of ${budget.max_attempts} attempts; recorded outcome budget_exhausted. The director decides what happens next (amendment or new order)`);
  }
  // ORD-0043 part 3: leaving `blocked` on a written reason runs the preflight first; a failing check starts nothing.
  if (byReason) requirePreflight(root, id, { now, optional: true });
  appendEvent(root, { type: 'order.state_changed', actor: 'executor', subject: id, agent, payload: { from, to: 'active', reason: why } }, { now });
  const { line } = appendEvent(root, { type: 'run.started', actor: 'executor', subject: id, agent, payload: { run: attempts + 1, budget, resumed: true } }, { now });
  return { run: attempts + 1, budget, line, from };
}

export const EVIDENCIA_HEADING = '## Evidencia';
export const hasEvidenciaSection = (text) => /^## Evidencia\s*$/m.test(String(text).replace(/\r\n/g, '\n'));

// ORD-0043 part 6 (OBS-165): the owner's corrections at the signature send a delivered order back for rework, with
// the transition delivered -> active that the state table has. The executor starts the next run with `aos run start`.
export function sendBackForRework(root, id, { documents = 0, isTTY, now = new Date() } = {}) {
  if (!isTTY) throw new RuleError('E_OWNER_TTY', 'sending an order back for corrections is the owner\'s decision, made in "aos sign" at their own terminal; stdin is not a TTY');
  const order = replay(readLog(root).events).orders[id];
  if (!order || order.state !== 'delivered') throw new RuleError('E_TRANSITION', `${id} is "${order?.state ?? 'unknown'}"; only a delivered order goes back for corrections`);
  appendEvent(root, { type: 'order.state_changed', actor: 'owner', subject: id, payload: { from: 'delivered', to: 'active', reason: `corrections by the owner at the signature (${documents} document(s)); back to the executor for rework` } }, { now });
}

// ORD-0043 part 5 (OBS-163, SPEC-0002 as amended by the order): another session takes an open run. The calling
// session becomes its owner, recorded with the existing event type operation.logged: no new run, no attempt
// consumed. The former owner is no longer blocked by the stop hook. A session declared director cannot take a run.
export function runTake(root, id, { agent, now = new Date() } = {}) {
  readOrderBudget(root, id); // E_NO_ORDER when the order file is missing
  const { events } = readLog(root);
  refuseDirectorRun(root, agent, events, 'take a run');
  const open = openRunOf(events, id);
  if (!open) throw new RuleError('E_TRANSITION', `${id} has no open run to take (state "${replay(events).orders[id]?.state ?? 'none'}")`);
  const session = typeof agent?.session === 'string' && agent.session ? agent.session : null;
  if (!session) throw new RuleError('E_MISSING_FIELD', 'the calling session is not known (no session id in the environment), so the run cannot be given to it; run "aos run take" from the session that goes on with the order');
  const run = open.event.payload?.run ?? null;
  if (open.session === session) return { run, session, from: session, taken: false };
  appendEvent(root, { type: 'operation.logged', actor: 'executor', subject: id, agent, payload: { operation: 'run.take', run, session, from: open.session } }, { now });
  return { run, session, from: open.session, taken: true };
}

// ORD-0043 part 4: the fixed line of the report, `Work: complete` or `Work: not complete`. Null when it has none.
export const workLine = (text) => /^Work: (complete|not complete)$/m.exec(String(text).replace(/\r\n/g, '\n'))?.[1] ?? null;

const NEXT_STATE = { done: 'delivered', blocked: 'blocked', needs_decision: 'blocked', budget_exhausted: 'queued', parts_cap: 'queued', failed: 'queued' };

export function runFinish(root, id, { outcome, evidence, blockedBy, reason, now = new Date(), agent } = {}) {
  if (!enums.run_outcomes.includes(outcome)) throw new RuleError('E_OUTCOME_ENUM', `--outcome ${JSON.stringify(outcome)} is not one of: ${enums.run_outcomes.join(', ')}`);
  if (!evidence) throw new RuleError('E_MISSING_FIELD', '--evidence <path> is required');
  if (!existsSync(join(root, evidence))) throw new RuleError('E_FILE_MISSING', `evidence file ${evidence} does not exist`);
  const budget = readOrderBudget(root, id);
  const { events } = readLog(root);
  const order = replay(events).orders[id];
  const started = openRun(events, id);
  if (!order || order.state !== 'active' || !started) {
    throw new RuleError('E_TRANSITION', `${id} has no open run (state "${order?.state ?? 'none'}"); use "aos run start ${id}" first`);
  }
  // ORD-0043 part 4 (OBS-166): finished work is never ended as blocked. A blocked order is not offered for
  // signature, so work that is complete would have no way to the owner: only the owner's review missing is `done`.
  let work = null;
  try { work = workLine(readFileSync(join(root, evidence), 'utf8')); } catch { /* a folder, or not text: no line */ }
  if (work === 'complete' && (outcome === 'blocked' || outcome === 'needs_decision')) {
    throw new RuleError('E_WORK_COMPLETE', `the report ${evidence} says "Work: complete", so the run cannot end as ${outcome}: finish with --outcome done. A review by the owner is asked with "aos review request <path> --order ${id}" and decided at the signature; "blocked" is for something that prevents the work. Nothing was recorded and the run stays open`);
  }
  // ORD-0043 part 9 (OBS-143): an order is not delivered while a recorded copy of real data remains. The same
  // function as `aos scratch check`. Any other outcome is not held: the next run may still need the copy.
  if (outcome === 'done') {
    const left = scratchCheck(root, id).remaining;
    if (left.length) {
      throw new RuleError('E_SCRATCH_REMAINS', `${left.length} item(s) of the recorded copies of data of ${id} remain: ${left.map(remainingLine).join('; ')}. Stop each process and delete each folder (only what the order names), check with "aos scratch check ${id}", then finish again. Nothing was recorded and the run stays open`);
    }
  }
  // ORD-0043 part 13 (OBS-169): an order is not delivered while its report lacks a line the verify file looks for.
  // The same function as `aos report check`. Any other outcome is not held by it.
  if (outcome === 'done') {
    const lacking = reportCheck(root, id, { path: evidence }).lines;
    if (lacking.length) {
      throw new RuleError('E_REPORT_LINES', `the report ${evidence} lacks ${lacking.length} line(s) that the verify file of ${id} looks for: ${lacking.map(missingLine).join('; ')}. Write each line in its exact form, check with "aos report check ${id}", then finish again. Nothing was recorded, the run stays open and no attempt was consumed`);
    }
  }
  const minutes = (now.getTime() - Date.parse(started.ts)) / 60000;
  const payload = { run: started.payload.run, outcome };
  if (minutes > budget.max_minutes) payload.over_budget = true;
  appendEvent(root, { type: 'run.finished', actor: 'executor', subject: id, agent, payload }, { now });
  appendEvent(root, { type: 'evidence.attached', actor: 'executor', subject: id, agent, payload: { level: 'derived', path: evidence } }, { now });
  const to = NEXT_STATE[outcome];
  const change = { from: 'active', to };
  if (to === 'blocked') {
    change.reason = reason ?? `run finished with outcome ${outcome}`;
    change.blocked_by = blockedBy ?? change.reason;
  } else if (to === 'queued') {
    change.reason = reason ?? `run finished with outcome ${outcome}; queued for another attempt`;
  }
  appendEvent(root, { type: 'order.state_changed', actor: 'executor', subject: id, agent, payload: change }, { now });
  removeHandoff(root, id); // ORD-0043 part 5: the handoff belongs to the open run; a finished run has none
  // ORD-0040 part 5 (SDG-001, phase 1): a report delivered as done carries the fixed section "## Evidencia". Its
  // absence is a warning for the caller to print, never a refusal: the outcome above is already recorded.
  let noEvidencia = false;
  if (outcome === 'done') {
    try {
      noEvidencia = !hasEvidenciaSection(readFileSync(join(root, evidence), 'utf8'));
    } catch { /* the evidence is a folder or cannot be read as text: nothing to warn about */ }
  }
  return { to, over_budget: Boolean(payload.over_budget), minutes, no_evidencia: noEvidencia, no_work_line: work === null };
}

// Git Bash on Windows (never the WSL launcher in System32), plain bash elsewhere.
export function findBash() {
  if (process.env.AOS_BASH) return process.env.AOS_BASH;
  if (process.platform !== 'win32') return 'bash';
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ];
  return candidates.find((c) => existsSync(c)) ?? 'bash';
}

// `onSample(s, total)` and `onCheck(result)` report progress while the checks run (ORD-0011), so a long
// verification is visibly alive; the CLI prints them as they come.
export function verify(root, id, { now: fixedNow, onSample = () => {}, onCheck = () => {} } = {}) {
  const started = fixedNow ?? new Date();
  const changed = checkLock(root);
  if (changed.length) {
    throw new RuleError('E_DIRECTOR_FILE_CHANGED', `director files differ from .analucia/director.lock: ${changed.map((c) => `${c.path} (${c.problem})`).join(', ')}. Only the director may change them and refresh the lock`);
  }
  const vrel = `.analucia/verify/${id}.json`;
  const vpath = join(root, vrel);
  if (!existsSync(vpath)) throw new RuleError('E_FILE_MISSING', `${vrel} is missing; the director writes the verify file`);
  const text = readFileSync(vpath, 'utf8');
  const schema = validateVerifyText(text, `${id}.json`);
  if (schema.length) throw new RuleError(schema[0].code, `${vrel}: ${schema[0].message}`);
  const { checks } = JSON.parse(text);
  const { events } = readLog(root);
  const order = replay(events).orders[id];
  if (!order) throw new RuleError('E_TRANSITION', `${id} has no record.created event`);

  // SPEC-0003 §4 as amended by ORD-0043 part 17 (AMD-0016 section 4): every check runs once, at every risk level. A
  // check that fails is run again, once (at risk high only), and its second result is the one that counts; the evidence shows both and
  // marks a check that passed on the second run. `samples` is 1; the repeated checks are named in the payload.
  const { tier, warning } = riskTier(root, id, events);
  const samples = 1;
  const bash = findBash();
  const results = [];
  const repeated = [];
  const report = [`# aos verify ${id} at ${timestampFor(root, started)}`, '', 'director lock: intact', `shell: ${bash}`, `risk: ${tier ?? 'none (admitted before SPEC-0003)'} · samples: ${samples}`, ''];
  if (warning) report.push(`warning: ${warning}`, '');
  // ORD-0034 §4: {order_commit} is the newest commit with the trailer "Analucia-Order: <id>", resolved once.
  const orderCommit = checks.some((c) => usesOrderCommit(c.run)) ? resolveOrderCommit(root, id) : null;
  if (orderCommit) report.push(`${ORDER_COMMIT} = ${orderCommit}`, '');
  const klass = (c) => (c.class === 'form' ? { class: 'form' } : {});
  // One run of one check: its result and its lines of the report.
  const runCheck = (c, i, label) => {
    if (usesOrderCommit(c.run) && !orderCommit) {
      report.push(`## ${label}check ${i + 1}: ${c.name}`, '', `$ ${c.run}`, `not run: E_NO_ORDER_COMMIT no commit has the trailer line "Analucia-Order: ${id}", so ${ORDER_COMMIT} cannot be resolved: FAIL`, `  next (executor): ${renderedNext('E_NO_ORDER_COMMIT')} — see docs/errors/E_NO_ORDER_COMMIT.md`, '');
      return { name: c.name, exit: null, expect_exit: c.expect_exit, passed: false, code: 'E_NO_ORDER_COMMIT', ...klass(c) };
    }
    const run = orderCommit ? resolveRun(c.run, orderCommit) : c.run;
    const r = spawnSync(bash, ['-c', run], { cwd: root, encoding: 'utf8', timeout: 15 * 60000, maxBuffer: 64 * 1024 * 1024 });
    const exit = r.status ?? -1;
    const passed = exit === c.expect_exit;
    report.push(`## ${label}check ${i + 1}: ${c.name}`, '', `$ ${c.run}`, ...(run !== c.run ? [`resolved: $ ${run}`] : []), `exit ${exit} (expected ${c.expect_exit}): ${passed ? 'PASS' : 'FAIL'}`, '', '```');
    report.push(`${(r.stdout ?? '') + (r.stderr ?? '') + (r.error ? `
${r.error.message}` : '')}`.trimEnd(), '```', '');
    return { name: c.name, exit, expect_exit: c.expect_exit, passed, ...klass(c) };
  };
  // A check that passes is reported as soon as it finishes (ORD-0011); a failed one after its second run.
  const first = checks.map((c, i) => { const r = runCheck(c, i, ''); if (r.passed) onCheck(r); return r; });
  checks.forEach((c, i) => {
    let result = first[i];
    // A check that could not even be resolved is not run again: nothing in it can change.
    if (tier === 'high' && !result.passed && result.code !== 'E_NO_ORDER_COMMIT') {
      const second = runCheck(c, i, 'second run, ');
      repeated.push(c.name);
      result = { ...second, first_exit: result.exit, repeated: true, ...(second.passed ? { passed_on_second_run: true } : {}) };
      report.push(second.passed ? `passed on the second run: ${c.name} (the first run exited ${first[i].exit}, expected ${c.expect_exit})` : `failed on both runs: ${c.name} (exits ${first[i].exit} and ${second.exit}, expected ${c.expect_exit})`, '');
    }
    results.push(result);
    if (!first[i].passed) onCheck(result);
  });
  // ORD-0043 part 13: the lines of `report_lines`, each tried on the report of the order as a check of class form.
  const lines = reportCheck(root, id);
  lines.entries.forEach((e, i) => {
    const passed = lines.exists && !lines.lines.includes(e);
    const result = { name: `report line: ${e.name}`, exit: passed ? 0 : 1, expect_exit: 0, passed, class: 'form' };
    results.push(result);
    onCheck(result);
    report.push(`## report line ${i + 1}: ${e.name}`, '', `pattern: ${e.pattern}`, `${lines.exists ? `a line of ${lines.path} matches` : `${lines.path} exists`}: ${passed ? 'PASS' : 'FAIL'}`, '');
  });
  const allPassed = results.every((r) => r.passed);
  // ORD-0043 part 2: the failed checks in two groups. A check of form may be waived by the owner at the signature;
  // a check of substance never.
  const groups = failedGroups(results);
  if (!allPassed) report.push(`failed checks of substance (${groups.substance.length}): ${groups.substance.join(', ') || 'none'}`, `failed checks of form (${groups.form.length}): ${groups.form.join(', ') || 'none'}`, '');
  if (repeated.length) report.push(`repeated once (${repeated.length}): ${repeated.join(', ')}`, '');
  report.push(`result: ${allPassed ? 'all checks passed' : 'FAILED'}`);

  const dir = join(root, '.analucia', 'evidence', id);
  mkdirSync(dir, { recursive: true });
  const n = readdirSync(dir).filter((f) => /^verify-\d+\.txt$/.test(f)).length + 1;
  const rel = `.analucia/evidence/${id}/verify-${String(n).padStart(2, '0')}.txt`;
  writeFileSync(join(root, rel), `${report.join('\n')}\n`);
  const now = fixedNow ?? new Date(); // events carry the time the checks finished
  appendEvent(root, { type: 'evidence.attached', actor: 'system', subject: id, payload: { level: 'verified', path: rel, passed: allPassed, samples, repeated, checks: results } }, { now });

  let moved = false;
  // Re-read: an order can only be verified from "delivered".
  const current = replay(readLog(root).events).orders[id];
  if (allPassed && current.state === 'delivered') {
    appendEvent(root, { type: 'order.state_changed', actor: 'system', subject: id, payload: { from: 'delivered', to: 'verified', evidence: rel } }, { now });
    moved = true;
  }
  if (!allPassed) throw Object.assign(new RuleError('E_VERIFY_FAILED', `${results.filter((r) => !r.passed).length} of ${results.length} checks failed (substance: ${results.filter((r) => !r.passed && r.class !== 'form').length}, form: ${results.filter((r) => !r.passed && r.class === 'form').length}); see ${rel}`), { results, evidence: rel, groups });
  return { results, evidence: rel, moved, samples, repeated, state: moved ? 'verified' : current.state };
}

// ORD-0043 part 2: the names of the failed checks, once each, in the two groups of the verify file.
export function failedGroups(results) {
  const failed = results.filter((r) => !r.passed);
  const names = (list) => [...new Set(list.map((r) => r.name))];
  return { substance: names(failed.filter((r) => r.class !== 'form')), form: names(failed.filter((r) => r.class === 'form')) };
}

// ORD-0043 part 2 (SPEC-0002 as amended by the order): the owner, at his own terminal, waives the failed checks of
// class form of a delivered order, each with a written reason of at least ten characters. Only when every failed
// check of the last verification is of class form and each one has its reason. The waivers are written into the
// verify evidence, marked WAIVED, and the order goes on to `verified` as an order whose checks all passed. The
// caller (aos sign) records them in the payload of owner.signed. A check of substance is never waived.
export const WAIVER_MIN_REASON = 10;
export function waiveFormChecks(root, id, { waivers, isTTY, now = new Date() } = {}) {
  if (!isTTY) throw new RuleError('E_OWNER_TTY', 'waiving a check of form needs the owner at an interactive terminal; stdin is not a TTY (agents cannot waive). The owner does it in "aos sign", in their own terminal');
  const { events } = readLog(root);
  const order = replay(events).orders[id];
  if (!order || order.state !== 'delivered') throw new RuleError('E_TRANSITION', `${id} is "${order?.state ?? 'unknown'}"; only a delivered order whose verification failed on checks of form can be waived`);
  const last = events.filter((e) => e.subject === id && e.type === 'evidence.attached' && e.payload?.level === 'verified').at(-1);
  if (!last || last.payload.passed) throw new RuleError('E_TRANSITION', `${id} has no failed verification to waive`);
  const groups = failedGroups(last.payload.checks ?? []);
  if (groups.substance.length) throw new RuleError('E_VERIFY_FAILED', `${id}: ${groups.substance.length} failed check(s) of substance (${groups.substance.join(', ')}); a check of substance is never waived`);
  const given = new Map((waivers ?? []).map((w) => [w.check, String(w.reason ?? '').trim()]));
  for (const name of groups.form) {
    if ((given.get(name) ?? '').length < WAIVER_MIN_REASON) throw new RuleError('E_NOT_CONFIRMED', `${id}: the check of form "${name}" has no written reason of at least ${WAIVER_MIN_REASON} characters; nothing was waived`);
  }
  const rel = last.payload.path;
  const stamp = timestampFor(root, now);
  const lines = ['', `## Waived by the owner at ${stamp} (aos sign)`, '', ...groups.form.map((name) => `WAIVED: ${name} — reason: ${given.get(name)}`), '', `result: every failed check was a check of form and was waived by the owner (${groups.form.length} waived)`];
  writeFileSync(join(root, rel), `${readFileSync(join(root, rel), 'utf8').trimEnd()}\n${lines.join('\n')}\n`);
  appendEvent(root, { type: 'order.state_changed', actor: 'system', subject: id, payload: { from: 'delivered', to: 'verified', evidence: rel, waived: groups.form } }, { now });
  return groups.form.map((check) => ({ order: id, check, reason: given.get(check) }));
}

// Closing. Owner: interactive terminal + typed CLOSE (any risk). `as: "director"`: no TTY, only `risk: low` orders
// (SPEC-0003 §4); any other `as`, or any other risk, is E_RISK_CLOSE. `isTTY` and `ask` are injected by the CLI.
export async function close(root, ids, { isTTY, ask, as, now = new Date() }) {
  if (!ids.length) throw new RuleError('E_MISSING_FIELD', 'name at least one order: aos close ORD-NNNN [ORD-…]');
  const { events } = readLog(root);
  const orders = replay(events).orders;
  const states = () => {
    for (const id of ids) {
      if (!orders[id]) throw new RuleError('E_TRANSITION', `${id} has no record.created event`);
      if (orders[id].state !== 'verified') throw new RuleError('E_TRANSITION', `${id} is "${orders[id].state}"; only "verified" orders can be closed`);
    }
  };
  if (as !== undefined) {
    if (as !== 'director') throw new RuleError('E_RISK_CLOSE', `"--as ${as}" is not allowed: only "--as director" exists, and only for risk: low orders`);
    for (const id of ids) {
      if (!existsSync(orderPath(root, id))) throw new RuleError('E_NO_ORDER', `no order file .analucia/orders/${id}.md`);
      const { tier } = riskTier(root, id, events);
      if (tier !== 'low') throw new RuleError('E_RISK_CLOSE', `${id} is ${tier ? `risk: ${tier}` : 'not risk-tiered (admitted before SPEC-0003)'}; only the owner closes it, from their own terminal`);
    }
    states();
    const directorMayClose = new Set(ids);
    for (const id of ids) appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: id, payload: { from: 'verified', to: 'closed', risk: 'low' } }, { now, directorMayClose });
    return ids;
  }
  if (!isTTY) throw new RuleError('E_OWNER_TTY', 'closing needs the owner at an interactive terminal; stdin is not a TTY (agents cannot close). The owner runs "aos close <ORD-…>" in their own terminal');
  states();
  const answer = await ask(`Orders to close (owner signature):\n${ids.map((id) => `  ${id}`).join('\n')}\nType CLOSE to sign: `);
  if (answer.trim() !== 'CLOSE') throw new RuleError('E_NOT_CONFIRMED', 'not closed: the confirmation was not "CLOSE"');
  for (const id of ids) appendEvent(root, { type: 'order.state_changed', actor: 'owner', subject: id, payload: { from: 'verified', to: 'closed' } }, { now });
  return ids;
}
