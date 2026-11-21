// One-click repair of the event log, for one kind of damage only (ORD-0042 part 4, OBS-155).
// The log is append-only and is never rewritten, with this one exception: `aos repair-log`, by the owner at his own
// terminal, when all three conditions hold:
//   1. the log does not verify;
//   2. the version of the log in the last commit verifies;
//   3. every line of the working file after that committed version is a session line (session.start, session.end,
//      role.declared), so no order, run, evidence, review or signature would be lost.
// The repair puts back the committed version, keeps the removed lines in a file under .analucia/views/ named with
// the time, and appends one operation.logged event saying what was removed and by whom. In every other case it
// changes nothing.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { personLocale } from './locale.mjs';
import { catalog } from './onboarding.mjs';
import { LOG_REL, appendEvent, logPath, timestampFor, verifyChain } from './log.mjs';
import { RuleError } from './state.mjs';

export const SESSION_LINE_TYPES = ['session.start', 'session.end', 'role.declared'];
export const REPAIR_WORD = 'REPAIR';

// The bytes of the log in the last commit, or null (no repository, no commit, or the log is not committed).
function committedLog(root) {
  const r = spawnSync('git', ['-C', root, 'show', `HEAD:${LOG_REL}`], { maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}
const countLines = (buf) => buf.toString('utf8').split('\n').filter(Boolean).length;

// What a repair would do, without doing it: { repairable: true, committed, removed, kinds, lines } or
// { repairable: false, condition: 1 | 2 | 3, why }.
export function repairPlan(root) {
  if (!existsSync(logPath(root))) return { repairable: false, condition: 1, why: `${LOG_REL} is missing` };
  const working = readFileSync(logPath(root));
  const broken = verifyChain(working);
  if (!broken) return { repairable: false, condition: 1, why: 'the log verifies: there is nothing to repair' };
  const base = committedLog(root);
  if (base === null) return { repairable: false, condition: 2, why: 'there is no version of the log in a commit to go back to (not a git repository, no commit, or the log was never committed)', broken };
  if (verifyChain(base)) return { repairable: false, condition: 2, why: 'the version of the log in the last commit does not verify either', broken };
  if (working.length < base.length || !working.subarray(0, base.length).equals(base)) {
    return { repairable: false, condition: 3, why: 'the working log does not start with the committed version: a line that was already committed was changed or removed', broken };
  }
  const lines = working.subarray(base.length).toString('utf8').split('\n').filter(Boolean);
  const kinds = {};
  const other = {};
  for (const line of lines) {
    let type = '(not readable)';
    try { type = JSON.parse(line).type ?? '(no type)'; } catch { /* counted as not readable */ }
    if (SESSION_LINE_TYPES.includes(type)) kinds[type] = (kinds[type] ?? 0) + 1;
    else other[type] = (other[type] ?? 0) + 1;
  }
  const lost = Object.values(other).reduce((a, b) => a + b, 0);
  if (lost) {
    const list = Object.entries(other).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k} ${v}`).join(', ');
    return { repairable: false, condition: 3, why: `after the committed version there are ${lost} line(s) that are not session lines (${list}): a repair would lose them`, broken };
  }
  const sorted = Object.fromEntries(SESSION_LINE_TYPES.filter((k) => kinds[k]).map((k) => [k, kinds[k]]));
  return { repairable: true, committed: countLines(base), removed: lines.length, kinds: sorted, lines, base, broken };
}

// aos repair-log. Owner only: a terminal and the typed word. Returns { removed, committed, kinds, kept_in }.
export async function repairLog(root, { isTTY, ask, out = () => {}, t = catalog(personLocale(root)), now = new Date() } = {}) {
  if (!isTTY) throw new RuleError('E_OWNER_TTY', 'repairing the log needs the owner at an interactive terminal; stdin is not a TTY (agents cannot repair the log). The owner double-clicks REPARAR or runs "aos repair-log" in their own terminal');
  const plan = repairPlan(root);
  if (!plan.repairable) throw new RuleError('E_LOG_NOT_REPAIRABLE', `condition ${plan.condition} of the repair does not hold: ${plan.why}. Nothing was changed`);
  const kinds = Object.entries(plan.kinds).map(([k, v]) => `${k} ${v}`).join(', ');
  const answer = await ask(t('repair.confirm', { removed: plan.removed, kinds, committed: plan.committed }));
  if (answer.trim() !== REPAIR_WORD) throw new RuleError('E_NOT_CONFIRMED', t('repair.not_confirmed'));
  // The removed lines are kept first; only then is the committed version put back.
  const stamp = timestampFor(root, now).replace(/[-:]/g, '').slice(0, 15);
  const kept = `.analucia/views/log-removed-${stamp}.jsonl`;
  mkdirSync(join(root, '.analucia', 'views'), { recursive: true });
  writeFileSync(join(root, kept), `${plan.lines.join('\n')}\n`);
  writeFileSync(logPath(root), plan.base);
  appendEvent(root, { type: 'operation.logged', actor: 'owner', subject: null, payload: { operation: 'log_repaired', removed: plan.removed, kinds: plan.kinds, kept_in: kept } }, { now });
  const after = verifyChain(readFileSync(logPath(root)));
  if (after) throw new RuleError(after.code, `after the repair the log still does not verify at line ${after.line} (${after.message})`);
  out(t('repair.done', { removed: plan.removed, kinds, kept }));
  return { removed: plan.removed, committed: plan.committed, kinds: plan.kinds, kept_in: kept };
}
