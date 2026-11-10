#!/usr/bin/env node
// aos: Analucia AOS command line (Node 20+, no dependencies). All commands accept --root <dir> (default: cwd).
//   aos validate [path]                 validate orders, project.json and events.jsonl (exit 0 valid, 1 invalid)
//   aos event append --type <t> --actor <role> [--subject <id>|null] [--payload <json>]
//                                       the only writer of .analucia/events.jsonl (appends one line)
//   aos verify-log                      recompute the hash chain; exit 1 at the first broken link
//   aos derive                          write .analucia/views/state.json and resume.md
//   aos history <subject>               print the events of one record
//   aos run start ORD-NNNN              executor: queued -> active + run.started (budget checked)
//   aos run finish ORD-NNNN --outcome <o> --evidence <path> [--blocked-by <id|reason>] [--reason <text>]
//   aos verify ORD-NNNN                 system: director lock, verify-file checks, delivered -> verified
//   aos close ORD-NNNN [ORD-…]          owner only, interactive terminal: verified -> closed
//   aos close ORD-NNNN --as director    risk: low only, no TTY (SPEC-0003 §4)
//   aos init [--locale] [--answers <file> [--dry-run]]   guided onboarding (owner TTY + CONFIRM to apply)
//   aos init --hosting <answer> [--dry-run]              change only the hosting answer (AMD-0006 §5)
//   aos permissions write               .claude/settings.json: permission profile + plugin enabled for this repo (SPEC-0004 §3, §7)
//   aos role declare director --scope "<paths>"   role.declared with the write scope (SPEC-0004 §6)
//   aos ask open ASK-NNNN               director: record.created + ask.opened for a locked ask file
//   aos ceo export [--out <path>] [--locale en|es] | aos ceo import <path>   the owner sheet (import: owner TTY + CONFIRM)
//   aos admit ORD-NNNN                  director: record.created with pins, draft -> ready -> queued
//   aos cost record --usd <n> --source "<text>" [--order ORD-NNNN] [--month YYYY-MM] | aos cost status [--month YYYY-MM]
//   aos halt --reason "<text>" | aos resume      owner only, interactive terminal: the off switch
//   aos check-writeback                 exit 2 while a run is open or the hash chain is broken (Stop/PreCompact)
//   aos backup [--remote origin] | --restore-hint  snapshot of the working tree to backup/<date> (ORD-0024)
//   aos hook session-start|session-end|pre-tool-use   read Claude Code hook JSON on stdin (plugin hooks)
//   aos agents-md sync | aos check-roles         one director: the analucia block in AGENTS.md
//   aos check-push [remote] [url] | aos install-git-hooks   right GitHub account on push
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { derive, summarize } from '../lib/derive.mjs';
import {
  agentsMdSync, checkPush, checkRoles, checkWriteback, findRoot, halt, installGitHooks, preToolUse, resume, sessionEnd, sessionStart,
} from '../lib/guards.mjs';
import { ALERT_NEXT, alertLine, costRecord, costSummary, currentMonth, readProject, statusLines } from '../lib/cost.mjs';
import { admit, close, pauseOrder, resumeOrder, runFinish, runStart, verify } from '../lib/lifecycle.mjs';
import { permissionsWrite } from '../lib/permissions.mjs';
import { LOCALES, catalog, onboardingCompleted, onboardingStarted, runInit } from '../lib/onboarding.mjs';
import { wizard } from '../lib/wizard.mjs';
import { requestReview } from '../lib/review.mjs';
import { backup, restoreHint } from '../lib/backup.mjs';
import { openOrders, workflowCheck } from '../lib/workflow.mjs';
import { initCheck } from '../lib/checks.mjs';
import { DEFAULT_SHEET, askOpen, ceoExport, ceoImport, describePlan } from '../lib/owner-sheet.mjs';
import { LOG_REL, appendEvent, logPath, readLog, timestampFor, verifyChain } from '../lib/log.mjs';
import { evalsReport, runEvals } from '../lib/evals.mjs';
import { adopt, needsAudit } from '../lib/adopt.mjs';
import { firstHour, firstHourText, writeFirstHourView } from '../lib/metrics.mjs';
import { installLauncher, sign } from '../lib/sign.mjs';
import { ERRORS, withNext } from '../lib/errors.mjs';
import { renderCommands } from '../lib/cli.mjs';
import { notInitialisedLine, withRootLine } from '../lib/session-lines.mjs';
import { personLocale, supportedLocale } from '../lib/locale.mjs';
import { formatError, isWarning, validateFile, validateTree } from '../lib/validate.mjs';

const USAGE = [
  'usage: aos validate [path]',
  '       aos event append --type <t> --actor <role> [--subject <id>|null] [--payload <json>]',
  '       aos verify-log',
  '       aos derive',
  '       aos history <subject>',
  '       aos run start ORD-NNNN [--agent <json>]',
  '       aos run finish ORD-NNNN --outcome <o> --evidence <path> [--blocked-by <id|reason>] [--reason <text>] [--agent <json>]',
  '       aos verify ORD-NNNN',
  '       aos close ORD-NNNN [ORD-…] [--as director]',
  '       aos admit ORD-NNNN',
  '       aos ask open ASK-NNNN',
  '       aos role declare <role> [--scope "<paths>"]',
  '       aos permissions write',
  '       aos init [--locale en|pt|zh-Hans|hi|es] [--answers <file.json> [--dry-run]] | aos init --hosting managed|own-server|"already: <where>"|later [--dry-run] | aos init --check',
  '       aos ceo export [--out <path>] [--locale en|es]',
  '       aos ceo import <path>',
  '       aos cost record --usd <n> --source "<text>" [--order ORD-NNNN] [--month YYYY-MM]',
  '       aos cost status [--month YYYY-MM]',
  '       aos halt --reason "<text>" | aos resume',
  '       aos check-writeback',
  '       aos hook session-start|session-end|pre-tool-use   (hook JSON on stdin)',
  '       aos agents-md sync | aos check-roles',
  '       aos check-push [remote] [url] | aos install-git-hooks',
  '       aos review request <path> --order ORD-NNNN | aos workflow check ORD-NNNN',
  '       aos backup [--remote origin] | aos backup --restore-hint',
  '       aos eval run',
  '       aos adopt [--locale en|es|pt|zh-Hans|hi]',
  '       aos metrics first-hour',
  '       aos pause ORD-NNNN --reason "<why>" | aos resume-order ORD-NNNN',
  '       aos sign | aos sign --install-launcher',
  '       aos explain <CODE>',
  '       (every command accepts --root <dir>)',
].join('\n');

// Flags that take no value.
const BOOLEAN_FLAGS = new Set(['dry-run', 'check', 'no-audit', 'install-launcher', 'restore-hint']);

function parseArgs(args) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        opts[key] = true;
        continue;
      }
      if (i + 1 >= args.length) throw new Error(`missing value for --${key}`);
      opts[key] = args[++i];
    } else {
      positional.push(args[i]);
    }
  }
  return { opts, positional };
}

const fail = (line, code, message) => {
  process.stdout.write(`${withNext(`${LOG_REL}:${line}: ${code} ${message}`, code)}\n`);
  return 1;
};

function cmdValidate({ opts, positional }) {
  const target = positional[0] ?? opts.root ?? '.';
  if (!existsSync(target)) {
    process.stderr.write(`aos: path not found: ${target}\n`);
    return 2;
  }
  const found = statSync(target).isDirectory() ? validateTree(target) : validateFile(target);
  // ORD-0034 §5: a warning (moving ref in a verify file of an order admitted before the rule) never changes the exit code.
  for (const e of found) process.stdout.write(`${isWarning(e) ? 'warning: ' : ''}${withNext(formatError(e), e.code)}\n`);
  return found.some((e) => !isWarning(e)) ? 1 : 0;
}

function cmdEvent({ opts, positional }, root) {
  if (positional[0] !== 'append') {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  for (const k of ['type', 'actor']) {
    if (!opts[k]) {
      process.stderr.write(`aos: --${k} is required\n`);
      return 2;
    }
  }
  let payload = {};
  if (opts.payload !== undefined) {
    try {
      payload = JSON.parse(opts.payload);
    } catch (x) {
      return fail(0, 'E_JSON', `--payload is not valid JSON: ${x.message}`);
    }
  }
  const subject = opts.subject === undefined || opts.subject === 'null' ? null : opts.subject;
  const before = existsSync(logPath(root)) ? readFileSync(logPath(root)).length : 0;
  try {
    const { event, line } = appendEvent(root, { type: opts.type, actor: opts.actor, subject, payload });
    process.stdout.write(`appended ${LOG_REL}:${line} ${event.id} ${event.type} ${event.subject ?? '-'}\n`);
    return 0;
  } catch (x) {
    if (!x.code) throw x;
    const lines = existsSync(logPath(root)) ? readLog(root).raw.length : 0;
    const after = existsSync(logPath(root)) ? readFileSync(logPath(root)).length : 0;
    if (after !== before) throw new Error('internal: log changed during a refused append');
    return fail(lines + 1, x.code, `${x.message} (nothing written)`);
  }
}

function cmdVerifyLog(_args, root) {
  if (!existsSync(logPath(root))) return fail(0, 'E_FILE_MISSING', `${LOG_REL} is missing`);
  const buf = readFileSync(logPath(root));
  const broken = verifyChain(buf);
  if (broken) return fail(broken.line, broken.code, broken.message);
  const lines = buf.length ? buf.toString('utf8').split('\n').length - 1 : 0;
  process.stdout.write(`${LOG_REL}: ${lines} lines, hash chain intact\n`);
  return 0;
}

function cmdDerive(_args, root) {
  const errors = validateTree(root).filter((e) => !isWarning(e));
  if (errors.length) {
    for (const e of errors) process.stdout.write(`${withNext(formatError(e), e.code)}\n`);
    return 1;
  }
  const { resume } = derive(root);
  process.stdout.write(`wrote .analucia/views/state.json and .analucia/views/resume.md (${resume.split('\n').length - 1} lines)\n`);
  return 0;
}

function cmdHistory({ positional }, root) {
  const subject = positional[0];
  if (!subject) {
    process.stderr.write('usage: aos history <subject>\n');
    return 2;
  }
  const { events } = readLog(root);
  let n = 0;
  events.forEach((e, i) => {
    if (e.subject !== subject) return;
    n++;
    const s = summarize(e);
    process.stdout.write(`${i + 1}. ${e.ts} ${e.type} ${e.actor}${s ? ` ${s}` : ''}\n`);
  });
  if (!n) process.stderr.write(`aos: no events for ${subject}\n`);
  return 0;
}

// Errors of the lifecycle and guard commands: "aos <cmd>: CODE message" on stderr, exit 1.
const refuse = (cmd, x) => {
  if (!x.code) throw x;
  process.stderr.write(`${withNext(`aos ${cmd}: ${x.code} ${x.message}`, x.code)}\n`);
  return 1;
};
// The locale of owner-facing lines: the one fallback of lib/locale.mjs (ORD-0033 B.3), as in the SessionStart hook.
const ownerLocale = (root) => personLocale(root);
const parseAgent = (opts) => (opts.agent === undefined ? undefined : JSON.parse(opts.agent));

function cmdRun({ opts, positional }, root) {
  const [sub, id] = positional;
  if (!['start', 'finish'].includes(sub) || !id) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  try {
    if (sub === 'start') {
      const r = runStart(root, id, { agent: parseAgent(opts) });
      for (const w of r.warnings) process.stdout.write(`warning: ${w}\n`);
      process.stdout.write(`${id}: queued -> active, run ${r.run} of ${r.budget.max_attempts} started (budget ${r.budget.max_minutes} min${r.tier ? `, risk ${r.tier}` : ''})\n`);
    } else {
      const r = runFinish(root, id, { outcome: opts.outcome, evidence: opts.evidence, blockedBy: opts['blocked-by'], reason: opts.reason, agent: parseAgent(opts) });
      process.stdout.write(`${id}: run finished (${opts.outcome}${r.over_budget ? ', over budget' : ''}), evidence attached, active -> ${r.to}\n`);
    }
    return 0;
  } catch (x) {
    return refuse(`run ${sub}`, x);
  }
}

function cmdVerify({ positional }, root) {
  const id = positional[0];
  if (!id) {
    process.stderr.write('usage: aos verify ORD-NNNN\n');
    return 2;
  }
  // Each check is printed as it finishes (ORD-0011), not only at the end.
  const onSample = (s, total) => process.stdout.write(`sample ${s} of ${total}\n`);
  const onCheck = (c) => process.stdout.write(c.passed ? `PASS ${c.name} (exit ${c.exit})\n` : `FAIL ${c.name} (exit ${c.exit}, expected ${c.expect_exit})\n`);
  try {
    const r = verify(root, id, { onSample, onCheck });
    process.stdout.write(`${id}: ${r.results.length} checks passed, evidence ${r.evidence}${r.moved ? ', delivered -> verified' : `, state stays "${r.state}"`}\n`);
    return 0;
  } catch (x) {
    return refuse('verify', x);
  }
}

async function cmdClose({ opts, positional }, root) {
  const isTTY = process.stdin.isTTY === true;
  const ask = async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  };
  try {
    const closed = await close(root, positional, { isTTY, ask, as: opts.as });
    process.stdout.write(`closed: ${closed.join(', ')}\n`);
    return 0;
  } catch (x) {
    return refuse('close', x);
  }
}

function cmdHalt({ opts }, root) {
  try {
    halt(root, { reason: opts.reason, isTTY: process.stdin.isTTY === true });
    process.stdout.write('halted: every tool call except reads is blocked until the owner runs "aos resume"\n');
    return 0;
  } catch (x) {
    return refuse('halt', x);
  }
}

function cmdResume(_args, root) {
  try {
    resume(root, { isTTY: process.stdin.isTTY === true });
    process.stdout.write('resumed: .analucia/HALT removed\n');
    return 0;
  } catch (x) {
    return refuse('resume', x);
  }
}

// Hooks and guards find the project from --root, CLAUDE_PROJECT_DIR, the hook's cwd, or the current directory.
const guardRoot = (opts, input = {}) => (opts.root ? opts.root : findRoot(process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? '.'));

function cmdCheckWriteback({ opts }) {
  const root = guardRoot(opts);
  if (!root) return 0;
  const message = checkWriteback(root);
  if (!message) return 0;
  process.stderr.write(`${renderCommands(message)}\n`); // the command that exists here, not "aos run finish"
  return 2;
}

function cmdHook({ opts, positional }) {
  let input = {};
  try {
    const text = readFileSync(0, 'utf8');
    if (text.trim()) input = JSON.parse(text);
  } catch {
    input = {};
  }
  const root = guardRoot(opts, input);
  // ORD-0029 A: SessionStart is never silent. Without a project root it says so, names the folder it searched
  // from, and gives the real command that initialises it. The other hooks stay quiet outside a project.
  if (!root && positional[0] === 'session-start') {
    process.stdout.write(`${notInitialisedLine(input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd())}\n`);
    return 0;
  }
  if (!root) return 0; // not an Analucia project
  if (positional[0] === 'session-start') {
    process.stdout.write(withRootLine(sessionStart(root, input), root, input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd()));
    return 0;
  }
  if (positional[0] === 'session-end') {
    const message = sessionEnd(root, input);
    if (message) process.stderr.write(`${message}\n`);
    return 0;
  }
  if (positional[0] === 'pre-tool-use') {
    const message = preToolUse(root, input);
    if (!message) return 0;
    process.stderr.write(`${message}\n`);
    return 2;
  }
  process.stderr.write('usage: aos hook session-start|session-end|pre-tool-use\n');
  return 2;
}

function cmdAgentsMd({ positional }, root) {
  if (positional[0] !== 'sync') {
    process.stderr.write('usage: aos agents-md sync\n');
    return 2;
  }
  try {
    const r = agentsMdSync(root);
    process.stdout.write(`AGENTS.md ${r.changed ? 'updated' : 'unchanged'}${r.claudeCreated ? '; CLAUDE.md created with "@AGENTS.md"' : ''}\n`);
    return 0;
  } catch (x) {
    return refuse('agents-md sync', x);
  }
}

function cmdCheckRoles(_args, root) {
  const problems = checkRoles(root);
  for (const p of problems) process.stderr.write(`${withNext(`aos check-roles: E_ROLES ${p}`, 'E_ROLES')}\n`);
  if (!problems.length) process.stdout.write('check-roles: ok (one analucia block in AGENTS.md; CLAUDE.md imports @AGENTS.md)\n');
  return problems.length ? 1 : 0;
}

function cmdCheckPush({ positional }, root) {
  try {
    const r = checkPush(root, { remote: positional[0] || 'origin', url: positional[1] || undefined });
    process.stdout.write(`check-push: ok (${r.owner}, ${r.url}; ${r.commits} commit(s) in ${r.range}: order trailers and secret patterns clean)\n`);
    return 0;
  } catch (x) {
    const code = refuse('check-push', x);
    for (const p of x.problems ?? []) process.stderr.write(`    - ${p}\n`);
    return code;
  }
}

function cmdPermissions({ positional }, root) {
  if (positional[0] !== 'write') {
    process.stderr.write('usage: aos permissions write\n');
    return 2;
  }
  try {
    const r = permissionsWrite(root);
    process.stdout.write(`${r.path} ${r.changed ? 'written' : 'unchanged'} (allow/ask/deny profile${r.marketplace ? `; plugin ${r.marketplace.plugin}@${r.marketplace.name} enabled from github ${r.marketplace.repo}` : ''}); .claude/settings.local.json untouched\n`);
    return 0;
  } catch (x) {
    return refuse('permissions write', x);
  }
}

// aos role declare <role> [--scope "<paths>"] (SPEC-0004 §6): role.declared with the declared scope.
function cmdRole({ opts, positional }, root) {
  const [sub, role] = positional;
  if (sub !== 'declare' || !role) {
    process.stderr.write('usage: aos role declare <role> [--scope "<path>, <path>, …"]\n');
    return 2;
  }
  try {
    const scope = opts.scope === undefined ? undefined : opts.scope.split(/[,\s]+/).filter(Boolean);
    if (role === 'director' && !scope?.length) throw Object.assign(new Error('the director declares its write scope: --scope "<paths>"'), { code: 'E_MISSING_FIELD' });
    const payload = { role, ...(scope ? { scope } : {}) };
    const { line } = appendEvent(root, { type: 'role.declared', actor: role, subject: null, payload, agent: parseAgent(opts) });
    process.stdout.write(`role.declared ${role}${scope ? ` scope [${scope.join(', ')}]` : ''} (${LOG_REL}:${line})\n`);
    return 0;
  } catch (x) {
    return refuse('role declare', x);
  }
}

function cmdInstallGitHooks(_args, root) {
  try {
    const r = installGitHooks(root, fileURLToPath(import.meta.url));
    process.stdout.write(`${r.file} ${r.changed ? 'written' : 'unchanged'}; core.hooksPath = .githooks (repo-local)\n`);
    return 0;
  } catch (x) {
    return refuse('install-git-hooks', x);
  }
}

// Levenshtein distance, for "close matches" of an unknown code.
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

function cmdExplain({ positional }) {
  const code = String(positional[0] ?? '').toUpperCase();
  // The checks of the adoption audit (SPEC-0006 §4) have pages too.
  const adoptPage = fileURLToPath(new URL(`../docs/adopt/${code}.md`, import.meta.url));
  if (/^AD-[A-Z-]+$/.test(code) && existsSync(adoptPage)) {
    process.stdout.write(renderCommands(readFileSync(adoptPage, 'utf8')));
    return 0;
  }
  if (ERRORS[code]) {
    process.stdout.write(renderCommands(readFileSync(fileURLToPath(new URL(`../docs/errors/${code}.md`, import.meta.url)), 'utf8')));
    return 0;
  }
  const words = code.replace(/^E_/, '').split('_').filter(Boolean);
  const matches = Object.keys(ERRORS)
    .map((c) => ({ c, score: distance(code, c) - 3 * words.filter((w) => c.includes(w)).length }))
    .sort((x, y) => x.score - y.score || (x.c < y.c ? -1 : 1))
    .slice(0, 5)
    .map((m) => m.c);
  process.stderr.write(`${withNext(`aos explain: E_UNKNOWN_CODE ${JSON.stringify(positional[0] ?? '')} is not a registered code; close matches: ${matches.join(', ')}`, 'E_UNKNOWN_CODE')}\n`);
  return 2;
}

function cmdAdmit({ positional }, root) {
  const id = positional[0];
  if (!id) {
    process.stderr.write('usage: aos admit ORD-NNNN\n');
    return 2;
  }
  try {
    // AMD-0007 §4: the open orders first, as a reminder; information only, it never blocks.
    const t = catalog(ownerLocale(root));
    const open = openOrders(root);
    process.stdout.write(`${t('admit.open_title', { n: open.length })}\n`);
    for (const o of open) process.stdout.write(`  - ${o.id} ${o.title} (${o.state})\n`);
    process.stdout.write(`${t('admit.open_hint')}\n\n`);
    const { pins } = admit(root, id);
    process.stdout.write(`${id}: admitted (record.created, draft -> ready -> queued, actor director); pins plugin ${pins.plugin}, ${Object.entries(pins.specs).map(([k, v]) => `${k} ${v}`).join(', ')}\n`);
    return 0;
  } catch (x) {
    return refuse('admit', x);
  }
}

function cmdCost({ opts, positional }, root) {
  const sub = positional[0];
  try {
    if (sub === 'record') {
      const r = costRecord(root, { usd: opts.usd, source: opts.source, order: opts.order, month: opts.month, actor: opts.actor });
      process.stdout.write(`cost recorded: $${r.usd.toFixed(2)} for ${r.month}${opts.order ? ` (${opts.order})` : ''}, source: ${opts.source}\n`);
      for (const t of r.fired) process.stdout.write(`${alertLine(t, r.summary)}\n${ALERT_NEXT}\n`);
      return 0;
    }
    if (sub === 'status') {
      const month = opts.month ?? currentMonth(new Date(), root);
      const s = costSummary(readLog(root).events, readProject(root), month);
      process.stdout.write(`${statusLines(s).join('\n')}\n`);
      return 0;
    }
  } catch (x) {
    return refuse(`cost ${sub}`, x);
  }
  process.stderr.write('usage: aos cost record --usd <n> --source "<text>" [--order ORD-NNNN] [--month YYYY-MM] | aos cost status [--month YYYY-MM]\n');
  return 2;
}

function cmdAsk({ positional }, root) {
  if (positional[0] !== 'open' || !positional[1]) {
    process.stderr.write('usage: aos ask open ASK-NNNN\n');
    return 2;
  }
  try {
    const p = askOpen(root, positional[1]);
    process.stdout.write(`${positional[1]}: opened (${p.kind}; options ${p.options.join(', ')}); it appears under Pending signatures\n`);
    return 0;
  } catch (x) {
    return refuse('ask open', x);
  }
}

async function cmdCeo({ opts, positional }, root) {
  const sub = positional[0];
  try {
    if (sub === 'export') {
      const r = ceoExport(root, { out: opts.out ?? DEFAULT_SHEET, locale: opts.locale ?? 'en' });
      process.stdout.write(`wrote ${r.path} (${r.bytes} bytes; ${r.asks} asks, ${r.orders} orders). Open it in Excel; fill only the yellow cells.\n`);
      return 0;
    }
    if (sub === 'import' && positional[1]) {
      const isTTY = process.stdin.isTTY === true;
      const ask = async (question) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          return await rl.question(question);
        } finally {
          rl.close();
        }
      };
      const plan = await ceoImport(root, positional[1], { isTTY, ask });
      process.stdout.write(plan.length ? `recorded:\n${describePlan(plan).join('\n')}\n` : 'nothing to record: no decision or sign-off is filled in\n');
      return 0;
    }
  } catch (x) {
    const code = refuse(`ceo ${sub}`, x);
    for (const p of x.problems ?? []) process.stderr.write(`    - ${p}\n`);
    return code;
  }
  process.stderr.write('usage: aos ceo export [--out <path>] [--locale en|es] | aos ceo import <path>\n');
  return 2;
}

// aos init (SPEC-0005 §2): the interview (owner TTY), or --answers <file> [--dry-run].
async function cmdInit({ opts }, root) {
  const isTTY = process.stdin.isTTY === true;
  const rl = () => createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (question) => {
    const r = rl();
    try {
      return await r.question(question);
    } finally {
      r.close();
    }
  };
  const out = (s) => process.stdout.write(`${s}\n`);
  // aos init --check: only the checks of SPEC-0005 §5 (exit 0 without FAIL, 1 with at least one FAIL).
  if (opts.check === true) return initCheck(root, { out, locale: personLocale(root, { flag: opts.locale }) });
  try {
    let provided = {};
    let fileLocale;
    if (opts.answers) {
      if (!existsSync(opts.answers)) throw Object.assign(new Error(`answers file ${opts.answers} does not exist`), { code: 'E_FILE_MISSING' });
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(opts.answers, 'utf8'));
      } catch (x) {
        throw Object.assign(new Error(`answers file ${opts.answers} is not valid JSON (${x.message})`), { code: 'E_JSON' });
      }
      provided = parsed.answers ?? {};
      fileLocale = parsed.locale;
    }
    // AMD-0006 §5: aos init --hosting <answer> changes only that answer; the others are kept.
    if (typeof opts.hosting === 'string') provided = { ...provided, hosting: opts.hosting };
    // ORD-0033 B.3: the flag (or the answers file), the project, the system, then en. An unknown flag value is
    // still refused by the catalog, as before.
    const flag = opts.locale ?? fileLocale;
    const locale = flag !== undefined && !supportedLocale(flag) ? flag : personLocale(root, { flag });
    const dryRun = opts['dry-run'] === true;
    let useWizard = false;
    // ORD-0033 B.2: nothing is written before CONFIRM. The owner's first hour (AMD-0004) still starts with the
    // interview: its start time is kept here and recorded in onboarding.started, appended once the plan is approved.
    const startedAt = new Date();
    let started = false;
    if (!opts.answers && typeof opts.hosting !== 'string') {
      if (!isTTY) throw Object.assign(new Error('the onboarding interview needs the owner at an interactive terminal; an agent may prepare an answers file and run "aos init --answers <file> --dry-run"'), { code: 'E_OWNER_TTY' });
      // ORD-0029 C: the interview is the 15-question wizard; its language answer sets the plan and CONFIRM prompt.
      ({ provided } = await wizard(root, { locale, ask, out }));
      useWizard = true;
      started = true;
    } else if (opts.answers && !dryRun && isTTY) {
      started = true;
    }
    const onConfirmed = started ? () => onboardingStarted(root, { startedAt }) : undefined;
    const r = await runInit(root, { provided, locale, dryRun, isTTY, ask, out, wizard: useWizard, onConfirmed });
    // aos init runs the checks at its end (not after a dry run: a dry run writes nothing, not even the inventory).
    if (!r.applied || (!opts.answers && typeof opts.hosting === 'string')) return 0;
    // SPEC-0006 §3: a project already under way (> 20 commits or > 50 tracked files) is audited before its
    // first order; the owner may skip it with --no-audit, which is logged.
    if (opts['no-audit'] === true) {
      appendEvent(root, { type: 'operation.logged', actor: 'owner', subject: null, payload: { operation: 'adoption_skipped' } });
    } else if (needsAudit(root)) {
      out('');
      adopt(root, { out });
    }
    return initCheck(root, { out: (s) => out(`\n${s}`), onDone: (results) => onboardingCompleted(root, results) });
  } catch (x) {
    return refuse('init', x);
  }
}

// aos eval run (ORD-0012): deterministic evaluations of the mechanisms; exit 0 only if every scenario passes.
async function cmdEval({ positional }, root) {
  if (positional[0] !== 'run') {
    process.stderr.write('usage: aos eval run\n');
    return 2;
  }
  const results = await runEvals();
  for (const r of results) process.stdout.write(`${r.passed ? 'PASS' : 'FAIL'} ${r.name}\n`);
  const passed = results.filter((r) => r.passed).length;
  process.stdout.write(`total: ${passed} of ${results.length} passed\n`);
  const ts = timestampFor(root);
  mkdirSync(`${root}/.analucia/views`, { recursive: true });
  writeFileSync(`${root}/.analucia/views/evals.md`, `${evalsReport(results, ts)}\n`);
  appendEvent(root, {
    type: 'eval.run', actor: 'system', subject: null,
    payload: { level: 'observed', total: results.length, passed, failed: results.length - passed, failed_scenarios: results.filter((r) => !r.passed).map((r) => r.name) },
  });
  process.stdout.write('wrote .analucia/views/evals.md\n');
  return passed === results.length ? 0 : 1;
}

// aos adopt (SPEC-0006): read-only audit. Exit 0 without high findings, 1 with one or more, 2 if it cannot run.
function cmdAdopt({ opts }, root) {
  try {
    if (opts.locale && !LOCALES.includes(opts.locale)) throw Object.assign(new Error(`--locale must be one of: ${LOCALES.join(', ')}`), { code: 'E_ANSWER_VALUE' });
    return adopt(root, { out: (s) => process.stdout.write(`${s}\n`), locale: opts.locale }).exit;
  } catch (x) {
    refuse('adopt', x);
    return 2;
  }
}

// aos metrics first-hour (AMD-0004): the four fields, from the log only; also refreshes the view.
function cmdMetrics({ positional }, root) {
  if (positional[0] !== 'first-hour') {
    process.stderr.write('usage: aos metrics first-hour\n');
    return 2;
  }
  const { events } = readLog(root);
  process.stdout.write(`${firstHourText(firstHour(events))}\n`);
  writeFirstHourView(root, events);
  return 0;
}

// AMD-0005 §2: the executor pauses and resumes one order (the global halt/resume do not change).
function cmdPause({ opts, positional }, root) {
  const id = positional[0];
  if (!id) {
    process.stderr.write('usage: aos pause ORD-NNNN --reason "<why>"\n');
    return 2;
  }
  try {
    const r = pauseOrder(root, id, { reason: opts.reason, agent: parseAgent(opts) });
    process.stdout.write(`${id}: run ${r.run} finished (blocked), active -> paused\n`);
    return 0;
  } catch (x) {
    return refuse('pause', x);
  }
}

function cmdResumeOrder({ opts, positional }, root) {
  const id = positional[0];
  if (!id) {
    process.stderr.write('usage: aos resume-order ORD-NNNN\n');
    return 2;
  }
  try {
    const r = resumeOrder(root, id, { agent: parseAgent(opts) });
    process.stdout.write(`${id}: paused -> active, run ${r.run} of ${r.budget.max_attempts} started\n`);
    return 0;
  } catch (x) {
    return refuse('resume-order', x);
  }
}

// AMD-0005 §3: aos sign (owner, terminal) and aos sign --install-launcher.
async function cmdSign({ opts }, root) {
  const out = (s) => process.stdout.write(`${s}\n`);
  if (opts['install-launcher'] === true) {
    installLauncher(root, { out });
    return 0;
  }
  const ask = async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  };
  try {
    // A refused push is reported in one line by sign() and is not an error of the signature itself.
    await sign(root, { isTTY: process.stdin.isTTY === true, ask, out });
    return 0;
  } catch (x) {
    return refuse('sign', x);
  }
}

// aos review request <path> --order ORD-NNNN (AMD-0007 §1): register a document for the owner's review.
function cmdReview({ opts, positional }, root) {
  if (positional[0] !== 'request' || !positional[1]) {
    process.stderr.write('usage: aos review request <path> --order ORD-NNNN\n');
    return 2;
  }
  try {
    const r = requestReview(root, positional[1], { order: opts.order, agent: parseAgent(opts) });
    process.stdout.write(`review.requested ${r.path} (${r.order}, sha256 ${r.sha256.slice(0, 12)}…): the owner decides in aos sign\n`);
    return 0;
  } catch (x) {
    return refuse('review request', x);
  }
}

// aos workflow check ORD-NNNN (AMD-0007 §3): design.md and plan.md have a current approve (exit 0) or not (exit 1).
function cmdWorkflow({ positional }, root) {
  if (positional[0] !== 'check' || !positional[1]) {
    process.stderr.write('usage: aos workflow check ORD-NNNN\n');
    return 2;
  }
  const r = workflowCheck(root, positional[1]);
  for (const l of r.lines) process.stdout.write(`${l}\n`);
  return r.ok ? 0 : 1;
}

// aos backup [--remote origin] | aos backup --restore-hint (ORD-0024 part A).
function cmdBackup({ opts }, root) {
  const t = catalog(ownerLocale(root));
  const remote = opts.remote ?? 'origin';
  if (opts['restore-hint'] === true) {
    const h = restoreHint(root, { remote });
    if (!h.branch) {
      process.stdout.write(`${t('backup.hint_none', { remote })}\n`);
      return 1;
    }
    process.stdout.write(`${t('backup.hint_title', { branch: h.branch, remote })}\n`);
    for (const c of h.commands) process.stdout.write(`  ${c}\n`);
    return 0;
  }
  try {
    const r = backup(root, { remote });
    process.stdout.write(`${t('backup.saved', { files: r.files, branch: r.branch, remote: r.remote })}\n`);
    return 0;
  } catch (x) {
    if (x.code === 'E_SECRET' && x.problems) {
      process.stderr.write(`${t('backup.refused', { n: x.problems.length })}\n`);
      for (const p of x.problems) process.stderr.write(`  ${p}\n`);
    }
    return refuse('backup', x);
  }
}

const commands = {
  backup: cmdBackup,
  review: cmdReview,
  workflow: cmdWorkflow,
  pause: cmdPause,
  'resume-order': cmdResumeOrder,
  sign: cmdSign,
  metrics: cmdMetrics,
  adopt: cmdAdopt,
  eval: cmdEval,
  init: cmdInit,
  permissions: cmdPermissions,
  role: cmdRole,
  ask: cmdAsk,
  ceo: cmdCeo,
  admit: cmdAdmit,
  cost: cmdCost,
  explain: cmdExplain,
  validate: cmdValidate, event: cmdEvent, 'verify-log': cmdVerifyLog, derive: cmdDerive, history: cmdHistory,
  run: cmdRun, verify: cmdVerify, close: cmdClose,
  halt: cmdHalt, resume: cmdResume, 'check-writeback': cmdCheckWriteback, hook: cmdHook,
  'agents-md': cmdAgentsMd, 'check-roles': cmdCheckRoles, 'check-push': cmdCheckPush, 'install-git-hooks': cmdInstallGitHooks,
};
const [cmd, ...rest] = process.argv.slice(2);
if (!commands[cmd]) {
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}
let parsed;
try {
  parsed = parseArgs(rest);
} catch (x) {
  process.stderr.write(`aos: ${x.message}\n`);
  process.exit(2);
}
process.exitCode = await commands[cmd](parsed, parsed.opts.root ?? '.');
