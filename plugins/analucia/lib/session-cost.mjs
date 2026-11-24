// ORD-0047 part 17 (OBS-215): the cost of each order is known. A hook receives no tokens, and with option B the
// application opens the session, not the dispatcher; so the tokens are read afterwards from Claude Code's own local
// session records, of THIS project's folder only, and only their usage fields (model and token counts). Never the text
// of a message, a prompt or a tool result: a record line is parsed and only `message.model`, `message.usage`,
// `message.id` and `requestId` are looked at; the rest of the line is dropped at once.
//
// Where the records are kept (documentation of Claude Code): `<config folder>/projects/<project folder, every
// character that is not a letter or a digit written as "-">/<session id>.jsonl`, one JSON object per line; the config
// folder is `CLAUDE_CONFIG_DIR` or `~/.claude`. An assistant line carries `message.usage` with `input_tokens`,
// `output_tokens`, `cache_creation_input_tokens` and `cache_read_input_tokens`; a line may carry `costUSD`.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// The orders measured start with this one: its own runs are the baseline (orders before it say "not measured").
export const BASELINE_ORDER = 'ORD-0047';

export const projectFolderName = (root) => resolve(root).replace(/[^A-Za-z0-9]/g, '-');
export const recordsDir = (root, env = process.env) => join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects', projectFolderName(root));

const SESSION_RE = /^[0-9a-fA-F-]{8,64}$/;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// The sessions each run of an order recorded: [{ run, session }], from `run.started` (its agent) and from the
// dispatcher's `operation.logged` rows that name a session. A session counts for the first run that names it.
export function runSessions(events, id) {
  const out = [];
  const seen = new Set();
  const add = (run, session) => { if (typeof session === 'string' && SESSION_RE.test(session) && !seen.has(session)) { seen.add(session); out.push({ run, session }); } };
  let run = 0;
  for (const e of events) {
    if (e.subject !== id) continue;
    if (e.type === 'run.started') { run = e.payload?.run ?? run + 1; add(run, e.agent?.session); }
    else if (e.type === 'operation.logged' && typeof e.payload?.session === 'string') add(e.payload?.run ?? run, e.payload.session);
  }
  return out;
}

// The usage of one session file: { <model>: { input, output, cache_creation, cache_read, cost_usd|null, messages } } or null
// when the file is not there. A message repeated in the file (same message id and request) counts once.
export function readUsage(file) {
  if (!existsSync(file)) return null;
  const by = {};
  const seen = new Set();
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    if (!raw.includes('"usage"')) continue; // a line with no usage is never parsed
    let o;
    try { o = JSON.parse(raw); } catch { continue; }
    const u = o?.message?.usage;
    if (!u || typeof u !== 'object') continue;
    const key = `${o.message.id ?? ''}|${o.requestId ?? ''}`;
    if (key !== '|') { if (seen.has(key)) continue; seen.add(key); }
    const model = typeof o.message.model === 'string' && o.message.model ? o.message.model : 'unknown';
    const m = (by[model] ??= { input: 0, output: 0, cache_creation: 0, cache_read: 0, cost_usd: null, messages: 0 });
    m.input += num(u.input_tokens);
    m.output += num(u.output_tokens);
    m.cache_creation += num(u.cache_creation_input_tokens);
    m.cache_read += num(u.cache_read_input_tokens);
    m.messages += 1;
    if (typeof o.costUSD === 'number') m.cost_usd = Math.round(((m.cost_usd ?? 0) + o.costUSD) * 1e6) / 1e6;
  }
  return by;
}

// Is the order one whose cost is measured (its first run is not before the first run of the baseline order)?
export function isMeasured(events, id) {
  const first = (o) => events.find((e) => e.subject === o && e.type === 'run.started');
  const base = first(BASELINE_ORDER);
  const mine = first(id);
  if (!mine || !base) return false;
  return Date.parse(mine.ts) >= Date.parse(base.ts);
}

// The tokens of an order, by run and in all: { measured, runs: [{ run, session, found, models }], total: { model: {…} }, cost_known }.
export function costSessions(root, events, id, { env = process.env, dir = recordsDir(root, env) } = {}) {
  if (!isMeasured(events, id)) return { measured: false, runs: [], total: {}, cost_known: false };
  const runs = runSessions(events, id).map(({ run, session }) => {
    const models = readUsage(join(dir, `${session}.jsonl`));
    return { run, session, found: models !== null, models: models ?? {} };
  });
  const total = {};
  for (const r of runs) {
    for (const [model, m] of Object.entries(r.models)) {
      const t = (total[model] ??= { input: 0, output: 0, cache_creation: 0, cache_read: 0, cost_usd: null, messages: 0 });
      for (const k of ['input', 'output', 'cache_creation', 'cache_read', 'messages']) t[k] += m[k];
      if (m.cost_usd !== null) t.cost_usd = Math.round(((t.cost_usd ?? 0) + m.cost_usd) * 1e6) / 1e6;
    }
  }
  const models = Object.values(total);
  return { measured: true, runs, total, cost_known: models.length > 0 && models.every((m) => m.cost_usd !== null) };
}

const fmt = (m) => `input ${m.input}, output ${m.output}, cache written ${m.cache_creation}, cache read ${m.cache_read}`;
// Lines for the terminal and the report.
export function costLines(id, r) {
  if (!r.measured) return [`${id}: not measured (the baseline starts with ${BASELINE_ORDER}; orders before it carry no cost figure)`];
  const lines = [];
  for (const run of r.runs) {
    if (!run.found) { lines.push(`run ${run.run} (session ${run.session}): not known (no record of this session in this project's folder)`); continue; }
    const ms = Object.entries(run.models);
    if (!ms.length) lines.push(`run ${run.run} (session ${run.session}): no usage in the record`);
    for (const [model, m] of ms) lines.push(`run ${run.run} (session ${run.session}) ${model}: ${fmt(m)}${m.cost_usd !== null ? `, cost $${m.cost_usd}` : ''}`);
  }
  if (!r.runs.length) lines.push(`${id}: no run recorded a session: tokens not known`);
  for (const [model, m] of Object.entries(r.total)) lines.push(`total ${model}: ${fmt(m)}${m.cost_usd !== null ? `, cost $${m.cost_usd}` : ''}`);
  if (Object.keys(r.total).length && !r.cost_known) lines.push('the records carry no cost: tokens only');
  return lines;
}
