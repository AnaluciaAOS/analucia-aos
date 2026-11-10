// Lifecycle commands (SPEC-0002 §3, SPEC-0003 §4–§5): admit, run start, run finish, verify, close.
// Every state change goes through appendEvent, so the ORD-0003 transition rules still apply.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enums } from './enums.mjs';
import { checkLock, hashLF, readLock } from './lock.mjs';
import { appendEvent, readLog, timestampFor } from './log.mjs';
import { RuleError, replay } from './state.mjs';
import { parseFrontMatter, validateOrderText, validateVerifyText } from './validate.mjs';
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
    const refs = validateVerifyText(readFileSync(join(root, vrel), 'utf8'), `${id}.json`, { movingRefs: { severity: 'error', branches: readBranches(root) } });
    if (refs.length) throw new RuleError(refs[0].code, `${vrel}:${refs[0].line}: ${refs[0].message}`);
  }
  const { events } = readLog(root);
  if (replay(events).records[id]) throw new RuleError('E_RECORD_EXISTS', `${id} already exists in the event log`);
  const pins = { plugin: pluginVersion, specs: specVersions(root) };
  appendEvent(root, { type: 'record.created', actor: 'director', subject: id, payload: { pins } }, { now });
  appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: id, payload: { from: 'draft', to: 'ready' } }, { now });
  appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: id, payload: { from: 'ready', to: 'queued' } }, { now });
  return { pins };
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

export function runStart(root, id, { now = new Date(), agent } = {}) {
  const budget = readOrderBudget(root, id);
  const { events } = readLog(root);
  const order = replay(events).orders[id];
  if (!order) throw new RuleError('E_TRANSITION', `${id} has no record.created event; the director must create and queue it`);
  if (order.state !== 'queued') throw new RuleError('E_TRANSITION', `${id} is "${order.state}"; "run start" needs "queued"`);
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
  appendEvent(root, { type: 'order.state_changed', actor: 'executor', subject: id, agent, payload: { from: 'queued', to: 'active' } }, { now });
  const { line } = appendEvent(root, { type: 'run.started', actor: 'executor', subject: id, agent, payload }, { now });
  return { run: attempts + 1, budget, line, tier, warnings };
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
export function resumeOrder(root, id, { now = new Date(), agent } = {}) {
  const budget = readOrderBudget(root, id);
  const { events } = readLog(root);
  const order = replay(events).orders[id];
  if (!order || order.state !== 'paused') throw new RuleError('E_TRANSITION', `${id} is "${order?.state ?? 'unknown'}"; "aos resume-order" needs "paused"`);
  const attempts = runsOf(events, id).length;
  if (attempts >= budget.max_attempts) {
    appendEvent(root, { type: 'run.finished', actor: 'executor', subject: id, agent, payload: { run: attempts + 1, outcome: 'budget_exhausted', refused_start: true, budget } }, { now });
    throw new RuleError('E_BUDGET', `${id} already used ${attempts} of ${budget.max_attempts} attempts; recorded outcome budget_exhausted. The director decides what happens next (amendment or new order)`);
  }
  appendEvent(root, { type: 'order.state_changed', actor: 'executor', subject: id, agent, payload: { from: 'paused', to: 'active', reason: 'resumed by the executor' } }, { now });
  const { line } = appendEvent(root, { type: 'run.started', actor: 'executor', subject: id, agent, payload: { run: attempts + 1, budget, resumed: true } }, { now });
  return { run: attempts + 1, budget, line };
}

const NEXT_STATE = { done: 'delivered', blocked: 'blocked', needs_decision: 'blocked', budget_exhausted: 'queued', failed: 'queued' };

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
  return { to, over_budget: Boolean(payload.over_budget), minutes };
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

  // SPEC-0003 §4: high risk runs every check twice (two samples); both must pass.
  const { tier, warning } = riskTier(root, id, events);
  const samples = tier === 'high' ? 2 : 1;
  const bash = findBash();
  const results = [];
  const report = [`# aos verify ${id} at ${timestampFor(root, started)}`, '', 'director lock: intact', `shell: ${bash}`, `risk: ${tier ?? 'none (admitted before SPEC-0003)'} · samples: ${samples}`, ''];
  if (warning) report.push(`warning: ${warning}`, '');
  // ORD-0034 §4: {order_commit} is the newest commit with the trailer "Analucia-Order: <id>", resolved once.
  const orderCommit = checks.some((c) => usesOrderCommit(c.run)) ? resolveOrderCommit(root, id) : null;
  if (orderCommit) report.push(`${ORDER_COMMIT} = ${orderCommit}`, '');
  for (let s = 1; s <= samples; s++) {
    if (samples > 1) onSample(s, samples);
    checks.forEach((c, i) => {
      if (usesOrderCommit(c.run) && !orderCommit) {
        const result = { name: c.name, exit: null, expect_exit: c.expect_exit, passed: false, code: 'E_NO_ORDER_COMMIT', ...(samples > 1 ? { sample: s } : {}) };
        results.push(result);
        onCheck(result);
        report.push(`## ${samples > 1 ? `sample ${s}, ` : ''}check ${i + 1}: ${c.name}`, '', `$ ${c.run}`, `not run: E_NO_ORDER_COMMIT no commit has the trailer line "Analucia-Order: ${id}", so ${ORDER_COMMIT} cannot be resolved: FAIL`, `  next (executor): ${renderedNext('E_NO_ORDER_COMMIT')} — see docs/errors/E_NO_ORDER_COMMIT.md`, '');
        return;
      }
      const run = orderCommit ? resolveRun(c.run, orderCommit) : c.run;
      const r = spawnSync(bash, ['-c', run], { cwd: root, encoding: 'utf8', timeout: 15 * 60000, maxBuffer: 64 * 1024 * 1024 });
      const exit = r.status ?? -1;
      const passed = exit === c.expect_exit;
      const result = { name: c.name, exit, expect_exit: c.expect_exit, passed, ...(samples > 1 ? { sample: s } : {}) };
      results.push(result);
      onCheck(result);
      report.push(`## ${samples > 1 ? `sample ${s}, ` : ''}check ${i + 1}: ${c.name}`, '', `$ ${c.run}`, ...(run !== c.run ? [`resolved: $ ${run}`] : []), `exit ${exit} (expected ${c.expect_exit}): ${passed ? 'PASS' : 'FAIL'}`, '', '```');
      report.push(`${(r.stdout ?? '') + (r.stderr ?? '') + (r.error ? `\n${r.error.message}` : '')}`.trimEnd(), '```', '');
    });
  }
  const allPassed = results.every((r) => r.passed);
  report.push(`result: ${allPassed ? 'all checks passed' : 'FAILED'}${samples > 1 ? ` (${samples} samples)` : ''}`);

  const dir = join(root, '.analucia', 'evidence', id);
  mkdirSync(dir, { recursive: true });
  const n = readdirSync(dir).filter((f) => /^verify-\d+\.txt$/.test(f)).length + 1;
  const rel = `.analucia/evidence/${id}/verify-${String(n).padStart(2, '0')}.txt`;
  writeFileSync(join(root, rel), `${report.join('\n')}\n`);
  const now = fixedNow ?? new Date(); // events carry the time the checks finished
  appendEvent(root, { type: 'evidence.attached', actor: 'system', subject: id, payload: { level: 'verified', path: rel, passed: allPassed, samples, checks: results } }, { now });

  let moved = false;
  // Re-read: an order can only be verified from "delivered".
  const current = replay(readLog(root).events).orders[id];
  if (allPassed && current.state === 'delivered') {
    appendEvent(root, { type: 'order.state_changed', actor: 'system', subject: id, payload: { from: 'delivered', to: 'verified', evidence: rel } }, { now });
    moved = true;
  }
  if (!allPassed) throw Object.assign(new RuleError('E_VERIFY_FAILED', `${results.filter((r) => !r.passed).length} of ${results.length} checks failed; see ${rel}`), { results, evidence: rel });
  return { results, evidence: rel, moved, samples, state: moved ? 'verified' : current.state };
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
