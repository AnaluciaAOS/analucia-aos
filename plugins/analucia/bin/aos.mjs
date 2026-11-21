#!/usr/bin/env node
// aos: Analucia AOS command line (Node 20+, no dependencies). All commands accept --root <dir> (default: cwd).
//   aos validate [path]                 validate orders, project.json and events.jsonl (exit 0 valid, 1 invalid)
//   aos event append --type <t> --actor <role> [--subject <id>|null] [--payload <json>] [--agent <json>]
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
//   aos permissions write [--local]     .claude/settings.json (or, with --local, .claude/settings.local.json): permission profile (+ plugin enabled for this repo) (SPEC-0004 §3, §7)
//   aos role declare director --scope "<paths>"   role.declared with the write scope (SPEC-0004 §6)
//   aos ask open ASK-NNNN               director: record.created + ask.opened for a locked ask file
//   aos ceo export [--out <path>] [--locale en|es] | aos ceo import <path>   the owner sheet (import: owner TTY + CONFIRM)
//   aos admit ORD-NNNN                  director: record.created with pins, draft -> ready -> queued
//   aos cost record --usd <n> --source "<text>" [--order ORD-NNNN] [--month YYYY-MM] | aos cost status [--month YYYY-MM]
//   aos halt --reason "<text>" | aos resume      owner only, interactive terminal: the off switch
//   aos check-writeback                 exit 2 while a run is open or the hash chain is broken (Stop); never blocks PreCompact
//   aos backup [--remote origin] | --restore-hint  snapshot of the working tree to backup/<date> (ORD-0024)
//   aos hook session-start|session-end|pre-tool-use   read Claude Code hook JSON on stdin (plugin hooks)
//   aos agents-md sync | aos check-roles         one director: the analucia block in AGENTS.md
//   aos check-push [remote] [url] | aos install-git-hooks   right GitHub account on push
//   aos next                            one line: the single thing that comes next and who does it (ORD-0040)
//   aos launchers install               the owner's click launchers: INICIAR, FIRMAR, DETENER, REANUDAR, IMPORTAR
//   aos ids                             the map of record IDs: each existing ID, the same number under the project code, the next free IDs
//   aos drafts                          the draft orders waiting in .analucia/drafts/ and whether each can be placed
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { derive, summarize } from '../lib/derive.mjs';
import {
  agentsMdSync, checkPush, checkRoles, checkWriteback, checkWritebackNote, compactNote, findRoot, halt, installGitHooks, preToolUse, resume, sessionEnd, sessionStart,
  trailerCheck, parsePushRefs,
} from '../lib/guards.mjs';
import { ALERT_NEXT, alertLine, costRecord, costSummary, currentMonth, readProject, statusLines } from '../lib/cost.mjs';
import { admit, close, pauseOrder, requirePreflight, resumeOrder, runFinish, runStart, runTake, verify } from '../lib/lifecycle.mjs';
import { handoffRel, writeHandoff } from '../lib/handoff.mjs';
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
import { DRAFTS_REL, listDrafts, nextOrderId } from '../lib/drafts.mjs';
import { LAUNCHER_NAMES, installLaunchers } from '../lib/launchers.mjs';
import { nextLine } from '../lib/next.mjs';
import { idsMap } from '../lib/ids.mjs';
import { okLine } from '../lib/ok-line.mjs';
import { repairLog } from '../lib/log-repair.mjs';
import { replacedCheck } from '../lib/replaces.mjs';
import { TERMINAL, chainOf, consumptionOf, metricOf, span, stagesOf, statusOf, waiversOf } from '../lib/status.mjs';
import { RuleError, replay } from '../lib/state.mjs';
import { waitingLine } from '../lib/waiting.mjs';
import { sessionName, sessionNameOutput } from '../lib/session-names.mjs';
import { wrongProjectNote } from '../lib/wrong-project.mjs';
import { docsCheck } from '../lib/earlier-records.mjs';
import { ERRORS, withNext } from '../lib/errors.mjs';
import { aosCommand, renderCommands } from '../lib/cli.mjs';
import { withRootLine } from '../lib/session-lines.mjs';
import { update, updateWarning } from '../lib/update.mjs';
import { remainingLine, scratchAdd, scratchCheck, scratchRel } from '../lib/scratch.mjs';
import { missingLine, reportCheck, reportTemplate } from '../lib/report.mjs';
import { tracked, trackedLine } from '../lib/tracked.mjs';
import { handleOwnerWord, ownerWord } from '../lib/owner-words.mjs';
import { personLocale, supportedLocale } from '../lib/locale.mjs';
import { formatError, isWarning, validateFile, validateTree } from '../lib/validate.mjs';

const USAGE = [
  'usage: aos validate [path] [--detail]',
  '       aos event append --type <t> --actor <role> [--subject <id>|null] [--payload <json>] [--agent <json>]',
  '       aos verify-log',
  '       aos derive',
  '       aos history <subject>',
  '       aos run start ORD-NNNN [--agent <json>]',
  '       aos run handoff ORD-NNNN --next "<what comes next>" | aos run take ORD-NNNN   (the handoff on disk; another session takes the open run)',
  '       aos run finish ORD-NNNN --outcome <o> --evidence <path> [--blocked-by <id|reason>] [--reason <text>] [--agent <json>]',
  '       aos verify ORD-NNNN',
  '       aos close ORD-NNNN [ORD-…] [--as director]',
  '       aos admit ORD-NNNN',
  '       aos preflight <order ID>',
  '       aos ask open ASK-NNNN',
  '       aos role declare <role> [--scope "<paths>"]',
  '       aos permissions write [--local]',
  '       aos init [--locale en|pt|zh-Hans|hi|es] [--answers <file.json> [--dry-run]] | aos init --hosting managed|own-server|"already: <where>"|later [--dry-run] | aos init --check',
  '       aos ceo export [--out <path>] [--locale en|es]',
  '       aos ceo import <path>',
  '       aos cost record --usd <n> --source "<text>" [--order ORD-NNNN] [--month YYYY-MM]',
  '       aos cost status [--month YYYY-MM]',
  '       aos halt --reason "<text>" | aos resume',
  '       aos repair-log',
  '       aos status [<order ID> [--chain [--json]]] | aos status --metric',
  '       aos decision record --text "<one line>" [--source <file>] --order <ID> [--order <ID> …]',
  '       aos check-writeback',
  '       aos hook session-start|session-end|pre-tool-use   (hook JSON on stdin)',
  '       aos agents-md sync | aos check-roles',
  '       aos check-push [remote] [url] | aos install-git-hooks',
  '       aos review request <path> --order ORD-NNNN | aos workflow check ORD-NNNN',
  '       aos backup [--remote origin] | aos backup --restore-hint',
  '       aos eval run',
  '       aos adopt [--locale en|es|pt|zh-Hans|hi]',
  '       aos metrics first-hour',
  '       aos pause ORD-NNNN --reason "<why>" | aos resume-order ORD-NNNN   (resume-order also leaves "blocked" once the block has ended)',
  '       aos resume-order ORD-NNNN --reason "<why the block has ended>" | aos unblock ORD-NNNN --reason "…"   (leaves "blocked" on a written reason)',
  '       aos sign | aos sign --install-launcher',
  '       aos next',
  '       aos launchers install',
  '       aos update',
  '       aos scratch add <order ID> --path <folder> [--pid <n>] | aos scratch check <order ID>',
  '       aos drafts',
  '       aos ids',
  '       aos docs check <order ID>',
  '       aos replaced check <order ID>',
  '       aos trailer check <order ID> --from <commit>',
  '       aos report template <order ID> | aos report check <order ID>',
  '       aos tracked <path> [<path> …]',
  '       aos explain <CODE>',
  '       (every command accepts --root <dir>)',
].join('\n');

// Flags that take no value.
const BOOLEAN_FLAGS = new Set(['dry-run', 'check', 'no-audit', 'install-launcher', 'restore-hint', 'chain', 'json', 'metric', 'detail', 'local']);
// Flags that may be given several times (aos decision record --order A --order B): kept as a list in opts.<key>s.
const REPEATED_FLAGS = new Set(['order']);

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
      if (REPEATED_FLAGS.has(key)) (opts[`${key}s`] ??= []).push(opts[key]);
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

// The IDs of the orders the log says are closed; none when the log cannot be read (then nothing is hidden).
function closedOrders(root) {
  try {
    return new Set(Object.entries(replay(readLog(root).events).orders).filter(([, o]) => o.state === 'closed').map(([id]) => id));
  } catch {
    return new Set();
  }
}

function cmdValidate({ opts, positional }) {
  const target = positional[0] ?? opts.root ?? '.';
  if (!existsSync(target)) {
    process.stderr.write(`aos: path not found: ${target}\n`);
    return 2;
  }
  const found = statSync(target).isDirectory() ? validateTree(target) : validateFile(target);
  // ORD-0043 part 8: the warnings that belong to a closed order are not printed (they cannot be fixed without
  // touching a signed order); the closing line counts them and --detail prints them. Errors are always printed.
  const closed = opts.detail || !statSync(target).isDirectory() ? new Set() : closedOrders(target);
  const ofClosed = (e) => isWarning(e) && closed.has(/([A-Z][A-Z0-9]*-\d{4,})\.(?:json|md)$/.exec(String(e.file).split(/[\\/]/).at(-1))?.[1]);
  const hidden = found.filter(ofClosed).length;
  // ORD-0034 §5: a warning (moving ref in a verify file of an order admitted before the rule) never changes the exit code.
  for (const e of found) if (!ofClosed(e)) process.stdout.write(`${isWarning(e) ? 'warning: ' : ''}${withNext(formatError(e), e.code)}\n`);
  if (found.some((e) => !isWarning(e))) return 1;
  sayOk(statSync(target).isDirectory() ? target : null, hidden ? 'validate_hidden' : 'validate', { errors: 0, warnings: found.length - hidden, hidden });
  return 0;
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
    // ORD-0041 part 5: --agent <json> is recorded when given (the session that owns a run). Never taken from the environment here.
    let agent;
    if (opts.agent !== undefined) {
      try {
        agent = JSON.parse(opts.agent);
      } catch (x) {
        return fail(0, 'E_JSON', `--agent is not valid JSON: ${x.message}`);
      }
    }
    const { event, line } = appendEvent(root, { type: opts.type, actor: opts.actor, subject, payload, ...(agent !== undefined ? { agent } : {}) });
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
  sayOk(root, 'verify_log', { lines });
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
  sayOk(root, 'derive');
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
// ORD-0041 part 6 (AMD-0015 §9): the one closing line of a command the owner runs, on success.
const sayOk = (root, command, facts) => process.stdout.write(`${okLine(catalog(ownerLocale(root)), command, facts)}\n`);
// The agent of an event: --agent <json> when given; else, inside a Claude Code session, the session of the shell that
// runs the command (CLAUDE_CODE_SESSION_ID), so a declared role and a started run belong to a session (ORD-0041
// parts 3 and 5). Outside a session: none, as before.
const parseAgent = (opts) => {
  if (opts.agent !== undefined) return JSON.parse(opts.agent);
  const session = process.env.CLAUDE_CODE_SESSION_ID;
  return session ? { tool: 'claude-code', session } : undefined;
};

function cmdRun({ opts, positional }, root) {
  const [sub, id] = positional;
  if (!['start', 'finish', 'handoff', 'take'].includes(sub) || !id) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  // ORD-0043 part 5: the handoff on disk, and another session taking the open run.
  if (sub === 'handoff') {
    if (typeof opts.next !== 'string' || !opts.next.trim()) {
      process.stderr.write('usage: aos run handoff ORD-NNNN --next "<the part or step that comes next>"\n');
      return 2;
    }
    try {
      const rel = writeHandoff(root, id, { next: opts.next.trim().replace(/\s*\r?\n\s*/g, ' '), by: 'aos run handoff' });
      if (!rel) throw new RuleError('E_TRANSITION', `${id} has no open run, so there is nothing to hand off. ${nextLine(root, { explicit: true })}`);
      process.stdout.write(`${id}: handoff written to ${rel} (generated, never committed). A new session reads it and takes the run with: ${aosCommand()} run take ${id}\n`);
      return 0;
    } catch (x) {
      return refuse('run handoff', x);
    }
  }
  if (sub === 'take') {
    try {
      const r = runTake(root, id, { agent: parseAgent(opts) });
      process.stdout.write(r.taken
        ? `${id}: run ${r.run} is now owned by this session (${r.session}); it was owned by ${r.from ?? 'no recorded session'}. No new run was started and no attempt was consumed. Read ${handoffRel(id)} if it exists, then go on.\n`
        : `${id}: run ${r.run} is already owned by this session (${r.session}); nothing was changed.\n`);
      return 0;
    } catch (x) {
      if (x.code === 'E_TRANSITION') x.message = `${x.message}. ${nextLine(root, { explicit: true })}`;
      return refuse('run take', x);
    }
  }
  try {
    if (sub === 'start') {
      const r = runStart(root, id, { agent: parseAgent(opts) });
      for (const w of r.warnings) process.stdout.write(`warning: ${w}\n`);
      process.stdout.write(`${id}: ${r.rework ? 'active (rework)' : 'queued -> active'}, run ${r.run} of ${r.budget.max_attempts} started (budget ${r.budget.max_minutes} min${r.tier ? `, risk ${r.tier}` : ''})\n`);
    } else {
      const r = runFinish(root, id, { outcome: opts.outcome, evidence: opts.evidence, blockedBy: opts['blocked-by'], reason: opts.reason, agent: parseAgent(opts) });
      process.stdout.write(`${id}: run finished (${opts.outcome}${r.over_budget ? ', over budget' : ''}), evidence attached, active -> ${r.to}\n`);
      // ORD-0040 part 5: a warning, never a refusal; the outcome is already recorded.
      if (r.no_work_line) process.stdout.write(`warning: ${catalog(ownerLocale(root))('run.no_work_line', { path: opts.evidence })}\n`); // ORD-0043 part 4
      if (r.no_evidencia) process.stdout.write(`warning: ${renderCommands(catalog(ownerLocale(root))('run.no_evidencia', { path: opts.evidence, template: 'plugins/analucia/templates/' }))}\n`);
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
  const onSample = () => {};
  const onCheck = (c) => process.stdout.write(c.passed ? `PASS ${c.passed_on_second_run ? '[passed on the second run] ' : ''}${c.name} (exit ${c.exit})\n` : `FAIL ${c.class === 'form' ? '[form] ' : ''}${c.name} (exit ${c.exit}, expected ${c.expect_exit})\n`); // ORD-0043 part 2: the two groups
  try {
    const r = verify(root, id, { onSample, onCheck });
    process.stdout.write(`${id}: ${r.results.length} checks passed, evidence ${r.evidence}${r.moved ? ', delivered -> verified' : `, state stays "${r.state}"`}\n`);
    return 0;
  } catch (x) {
    return refuse('verify', x);
  }
}

const askLine = async (question) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
};

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

async function cmdHalt({ opts }, root) {
  try {
    const isTTY = process.stdin.isTTY === true;
    // ORD-0040 part 4 (DETENER): at a real terminal the reason is asked in the window when it was not given.
    let reason = opts.reason;
    if (isTTY && !(reason && reason.trim())) reason = await askLine(catalog(ownerLocale(root))('halt.ask_reason'));
    halt(root, { reason, isTTY });
    process.stdout.write('halted: every tool call except reads is blocked until the owner runs "aos resume"\n');
    sayOk(root, 'halt');
    return 0;
  } catch (x) {
    return refuse('halt', x);
  }
}

function cmdResume(_args, root) {
  try {
    resume(root, { isTTY: process.stdin.isTTY === true });
    process.stdout.write('resumed: .analucia/HALT removed\n');
    sayOk(root, 'resume');
    return 0;
  } catch (x) {
    return refuse('resume', x);
  }
}

// Hooks and guards find the project from --root, CLAUDE_PROJECT_DIR, the hook's cwd, or the current directory.
const guardRoot = (opts, input = {}) => (opts.root ? opts.root : findRoot(process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? '.'));

function cmdCheckWriteback({ opts }) {
  // ORD-0041 part 5: the hook input (the session that is ending) on standard input, when there is one.
  let input = {};
  if (process.stdin.isTTY !== true) {
    try {
      const text = readFileSync(0, 'utf8');
      if (text.trim()) input = JSON.parse(text);
    } catch {
      input = {};
    }
  }
  const root = guardRoot(opts, input);
  if (!root) return 0;
  // ORD-0043 part 1: a compaction is never blocked; it gets one line and, with a run open here, the handoff on disk.
  if (input.hook_event_name === 'PreCompact') {
    const note = compactNote(root, input);
    if (note) process.stdout.write(`${renderCommands(note)}\n`);
    return 0;
  }
  const message = checkWriteback(root, input);
  if (!message) {
    // Not blocked: one line when another session has a run open.
    const note = checkWritebackNote(root, input);
    if (note) process.stdout.write(`${note}\n`);
    return 0;
  }
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
  // ORD-0040 part 3: that line is the one `aos next` prints for the same folder.
  if (!root && positional[0] === 'session-start') {
    process.stdout.write(`${nextLine(input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd())}\n`);
    const warning = updateWarningLine(null);
    if (warning) process.stdout.write(`${warning}\n`);
    return 0;
  }
  if (!root) return 0; // not an Analucia project
  // ORD-0041 part 3: the title of the session, from its role and the project. It prints one line of JSON, or nothing
  // when the session already has the name or a person named it. It writes nothing.
  // ORD-0042 part 8: the prompt hook. It names the session as above and, when the prompt belongs to another project,
  // adds one line of context for the session. It never blocks the prompt and writes nothing.
  if (positional[0] === 'user-prompt') {
    const output = sessionNameOutput(root, input) ?? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit' } };
    const note = wrongProjectNote(root, input.prompt);
    const context = [];
    // ORD-0043 part 15: the STOP of the owner wins, before anything else the hook says.
    const word = ownerWord(input.prompt);
    if (word) context.push(handleOwnerWord(root, input, word, catalog(ownerLocale(root))));
    if (note) context.push(catalog(ownerLocale(root))(note.key, note.vars));
    if (context.length) output.hookSpecificOutput.additionalContext = context.join(' ').replace(/\s*\r?\n\s*/g, ' ');
    if (context.length || output.hookSpecificOutput.sessionTitle) process.stdout.write(`${JSON.stringify(output)}\n`);
    return 0;
  }
  if (positional[0] === 'session-name') {
    const output = sessionNameOutput(root, input);
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
    return 0;
  }
  if (positional[0] === 'session-start') {
    const text = withRootLine(sessionStart(root, input), root, input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
    // ORD-0040 part 3: the one next step, right under the root line (the same line as `aos next`).
    const [status, rootLine, ...rest] = text.split('\n');
    // ORD-0041 part 3: the name of the session, said in words too, for a window that does not show the title a hook sets.
    const named = catalog(ownerLocale(root))('session.name', { name: sessionName(root, typeof input.session_id === 'string' ? input.session_id : null) });
    const warning = updateWarningLine(root); // ORD-0043 part 7: one line, never a block
    const stopHint = renderCommands(catalog(ownerLocale(root))('stop.hint')); // ORD-0043 part 15
    process.stdout.write([status, rootLine, nextLine(root, { explicit: true, session: typeof input.session_id === 'string' ? input.session_id : undefined }), ...(warning ? [warning] : []), named, stopHint, ...rest].join('\n'));
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
    // ORD-0040 part 2 (OBS-127): a blocked write of an order or a verify file says where a draft goes, and that an
    // order needs its verify file.
    // ORD-0043 part 10: a write in the .analucia/ of another project has its own code and next step, and no draft hint.
    if (message.includes('E_OTHER_PROJECT')) {
      process.stderr.write(`${withNext(message, 'E_OTHER_PROJECT')}\n`);
      return 2;
    }
    // ORD-0043 part 14: a file only the owner writes has its own code and next step.
    if (message.includes('E_OWNER_DATA')) {
      process.stderr.write(`${withNext(message, 'E_OWNER_DATA')}\n`);
      return 2;
    }
    const hint = /\.analucia\/(?:orders|verify)\//i.test(message) ? ` ${catalog(ownerLocale(root))('hook.draft_hint', { drafts: DRAFTS_REL })}` : '';
    process.stderr.write(`${message}${hint}\n`);
    return 2;
  }
  process.stderr.write('usage: aos hook session-start|session-end|session-name|user-prompt|pre-tool-use\n');
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
    // The pre-push hook's standard input lists the refs being pushed; a terminal has none.
    let stdin = '';
    if (!process.stdin.isTTY) { try { stdin = readFileSync(0, 'utf8'); } catch { /* no input */ } }
    const r = checkPush(root, { remote: positional[0] || 'origin', url: positional[1] || undefined, refs: parsePushRefs(stdin) });
    process.stdout.write(`check-push: ok (${r.owner}, ${r.url}; ${r.commits} commit(s) in ${r.range}: order trailers and secret patterns clean)\n`);
    return 0;
  } catch (x) {
    const code = refuse('check-push', x);
    for (const p of x.problems ?? []) process.stderr.write(`    - ${p}\n`);
    return code;
  }
}

function cmdPermissions({ positional, opts }, root) {
  if (positional[0] !== 'write') {
    process.stderr.write('usage: aos permissions write [--local]\n');
    return 2;
  }
  try {
    const local = Boolean(opts.local);
    const r = permissionsWrite(root, { local });
    process.stdout.write(`${r.path} ${r.changed ? 'written' : 'unchanged'} (allow/ask/deny profile${r.marketplace ? `; plugin ${r.marketplace.plugin}@${r.marketplace.name} enabled from github ${r.marketplace.repo}` : ''})${local ? '' : '; .claude/settings.local.json untouched'}\n`);
    sayOk(root, 'permissions', { path: r.path });
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
    sayOk(root, 'git_hooks', { file: r.file });
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
    const { pins, preflight } = admit(root, id);
    process.stdout.write(`${id}: admitted (record.created, draft -> ready -> queued, actor director); pins plugin ${pins.plugin}, ${Object.entries(pins.specs).map(([k, v]) => `${k} ${v}`).join(', ')}\n`);
    process.stdout.write(`${preflight.has ? t('preflight.passed', { n: preflight.results.length, evidence: preflight.evidence }) : t('preflight.none', { id })}\n`);
    sayOk(root, 'admit', { id });
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
      sayOk(root, 'ceo_export', { path: r.path });
      return 0;
    }
    const tty = process.stdin.isTTY === true;
    // ORD-0040 part 4 (IMPORTAR): the sheet dropped on the launcher, or asked in the window.
    if (sub === 'import' && !positional[1] && tty) {
      const typed = (await askLine(catalog(ownerLocale(root))('ceo.ask_path'))).trim().replace(/^["']|["']$/g, '');
      if (typed) positional[1] = typed;
    }
    if (sub === 'import' && !positional[1] && !tty) throw Object.assign(new Error('importing the owner sheet needs the owner at an interactive terminal; stdin is not a TTY (agents cannot import it). The owner drops the sheet on IMPORTAR or runs "aos ceo import <file>" in their own terminal'), { code: 'E_OWNER_TTY' });
    if (sub === 'import' && positional[1]) {
      const isTTY = tty;
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
      if (plan.length) sayOk(root, 'ceo_import', { n: plan.length });
      else sayOk(root, 'ceo_import_none');
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

// ORD-0043 part 3: `aos unblock` is the same command under the name the owner asked for.
const cmdResumeOrderAs = (name) => ({ opts, positional }, root) => {
  const id = positional[0];
  if (!id) {
    process.stderr.write(`usage: aos ${name} ORD-NNNN [--reason "<why the block has ended>"]\n`);
    return 2;
  }
  try {
    const r = resumeOrder(root, id, { agent: parseAgent(opts), reason: typeof opts.reason === 'string' ? opts.reason : undefined });
    process.stdout.write(`${id}: ${r.from} -> active, run ${r.run} of ${r.budget.max_attempts} started\n`);
    return 0;
  } catch (x) {
    return refuse(name, x);
  }
};
const cmdResumeOrder = cmdResumeOrderAs('resume-order');
const cmdUnblock = cmdResumeOrderAs('unblock');

// AMD-0005 §3: aos sign (owner, terminal) and aos sign --install-launcher.
async function cmdSign({ opts }, root) {
  const out = (s) => process.stdout.write(`${s}\n`);
  if (opts['install-launcher'] === true) {
    installLauncher(root, { out });
    sayOk(existsSync(`${root}/.analucia/project.json`) ? root : null, 'launcher_firmar', { dir: resolve(root).split(sep).join('/') });
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
    const r = await sign(root, { isTTY: process.stdin.isTTY === true, ask, out });
    if (r.signed?.length || r.placed?.length || r.reviewed?.length) sayOk(root, 'sign', { signed: r.signed?.length ? r.signed.join(', ') : '0', placed: r.placed?.length ?? 0, reviewed: r.reviewed?.length ?? 0 });
    else sayOk(root, 'sign_none');
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

// aos next (ORD-0040 part 3): exactly one line. Without --root it looks from the current folder upwards, as the
// hooks do; it works in a folder with no .analucia/ (the next step is to start). Exit 0 whenever it could answer.
// ORD-0043 part 7: one line when the installed plugin is older than the newest version this machine can see without
// the network. Never a block: any failure to work it out is silence.
function updateWarningLine(root) {
  try {
    const w = updateWarning(root);
    return w ? catalog(ownerLocale(root && existsSync(`${root}/.analucia/project.json`) ? root : null))('update.warning', { ...w, cmd: `${aosCommand()} update` }).replace(/\s*\r?\n\s*/g, ' ') : null;
  } catch {
    return null;
  }
}

function cmdNext({ opts }) {
  const explicit = typeof opts.root === 'string';
  process.stdout.write(`${nextLine(explicit ? opts.root : '.', { explicit, session: process.env.CLAUDE_CODE_SESSION_ID })}\n`); // ORD-0043 part 5: the session that asks
  // The next step stays one line on stdout (programs read it); the warning goes beside it.
  const warning = updateWarningLine(explicit ? opts.root : findRoot('.'));
  if (warning) process.stderr.write(`${warning}\n`);
  return 0;
}

// aos scratch add | check (ORD-0043 part 9): the copies of real data an order makes are declared and cleaned.
// Plain lines: `check` is meant for verify files. Names and numbers only, never content.
function cmdScratch({ opts, positional }, root) {
  const [sub, id] = positional;
  if (!['add', 'check'].includes(sub) || !id || (sub === 'add' && typeof opts.path !== 'string')) {
    process.stderr.write('usage: aos scratch add <order ID> --path <folder> [--pid <n>] | aos scratch check <order ID>\n');
    return 2;
  }
  try {
    if (sub === 'add') {
      const r = scratchAdd(root, id, { path: opts.path, pid: opts.pid ?? null });
      process.stdout.write(`${id}: ${r.added ? 'recorded' : 'already recorded'}: the copy of data at ${r.path}${r.pid ? ` (process ${r.pid})` : ''}; ${r.total} in ${scratchRel(id)}. Before the run ends as done it must be gone: ${aosCommand()} scratch check ${id}\n`);
      return 0;
    }
    const r = scratchCheck(root, id);
    if (!r.recorded) {
      process.stdout.write(`no copy of data recorded for ${id}\n`);
      return 0;
    }
    const copies = `${r.recorded} recorded ${r.recorded === 1 ? 'copy' : 'copies'} of data of ${id}`;
    if (r.remaining.length) {
      for (const x of r.remaining) process.stdout.write(`${remainingLine(x)}\n`);
      process.stdout.write(`${copies}: ${r.remaining.length} item(s) remain. Stop each process and delete each folder (only what the order names), then run this again\n`);
      return 1;
    }
    process.stdout.write(`${copies}: every folder is gone and every process has ended\n`);
    return 0;
  } catch (x) {
    return refuse(`scratch ${sub}`, x);
  }
}

// aos update (ORD-0043 part 7): any role, an agent included. It changes no project file and never edits the
// configuration folder by hand: the claude command-line tool does the update.
function cmdUpdate(_args, root) {
  const at = root && existsSync(`${root}/.analucia/project.json`) ? root : null;
  const t = catalog(ownerLocale(at));
  const r = update({});
  for (const row of r.rows) process.stdout.write(`${t('update.line', row)}\n`);
  if (!r.ok) {
    process.stderr.write(`${t(`update.${r.reason}`, { detail: r.detail ?? '' }).replace(/\s*\r?\n\s*/g, ' ')}\n`);
    return 1;
  }
  process.stdout.write(`${t('update.reopen')}\n`);
  sayOk(at, 'update', { n: r.rows.length, after: [...new Set(r.rows.map((x) => x.after))].join(', ') });
  return 0;
}

// aos launchers install (ORD-0040 part 4): any role, an agent included. It writes files only; each launcher opens a
// real console where only a person can answer, so E_OWNER_TTY stays on every owner-only command.
function cmdLaunchers({ positional }, root) {
  if (positional[0] !== 'install') {
    process.stderr.write('usage: aos launchers install\n');
    return 2;
  }
  const t = catalog(ownerLocale(existsSync(`${root}/.analucia/project.json`) ? root : null));
  for (const { file, status } of installLaunchers(root)) process.stdout.write(`${t('launchers.line', { file, status: t(`status.${status}`) })}\n`);
  process.stdout.write(`${t('launchers.done')}\n`);
  sayOk(existsSync(`${root}/.analucia/project.json`) ? root : null, 'launchers', { n: LAUNCHER_NAMES.length, dir: resolve(root).split(sep).join('/') });
  return 0;
}

// aos drafts (ORD-0040 part 2): the drafts waiting and whether each can be placed. Read-only, any role.
// Exit 0 when every draft is ready (or there is none), 1 when at least one is not.
function cmdDrafts(_args, root) {
  const t = catalog(ownerLocale(root));
  const drafts = listDrafts(root);
  if (!drafts.length) {
    process.stdout.write(`${t('drafts.none', { id: nextOrderId(root), dir: DRAFTS_REL })}\n`);
    return 0;
  }
  for (const d of drafts) {
    process.stdout.write(`${d.ok ? t('drafts.ready', { id: d.id, title: d.title }) : t('drafts.not_ready', { id: d.id })}\n`);
    for (const p of d.problems) process.stdout.write(`    - ${p}\n`);
  }
  process.stdout.write(`${t('drafts.footer', { id: nextOrderId(root) })}\n`);
  return drafts.every((d) => d.ok) ? 0 : 1;
}

// aos ids (ORD-0041 part 1): the map for people. Each existing record with its ID and the same number under the
// project code, then the next free ID of each kind. One line when the project has no code yet. Reads only.
function cmdIds(_args, root) {
  const t = catalog(ownerLocale(root));
  const map = idsMap(root);
  if (!map.code) {
    process.stdout.write(`${t('ids.no_code', { order: map.next.order, amendment: map.next.amendment, ask: map.next.ask })}\n`);
    return 0;
  }
  process.stdout.write(`${t('ids.title', { code: map.code, n: map.records.length })}\n`);
  const width = Math.max(0, ...map.records.map((r) => r.id.length));
  for (const r of map.records) process.stdout.write(`${r.id.padEnd(width)}  =  ${r.under_code}${r.id === r.under_code ? '' : `  ${t('ids.same_record')}`}\n`);
  process.stdout.write(`${t('ids.next', { order: map.next.order, amendment: map.next.amendment, ask: map.next.ask })}\n`);
  return 0;
}

// aos docs check <ID> (ORD-0041 part 2, AMD-0015 §3): for the commits of that order, every file added inside a folder
// of earlier records must be named, by its path, in the order or one of its amendments. Meant for verify files.
// Exit 0 when it holds (or the project has no such folder), 1 with the list, 2 on a usage error.
function cmdDocs({ positional }, root) {
  if (positional[0] !== 'check' || !positional[1]) {
    process.stderr.write('usage: aos docs check <order ID>\n');
    return 2;
  }
  const t = catalog(ownerLocale(root));
  const id = positional[1];
  const r = docsCheck(root, id);
  if (!r.folders) {
    process.stdout.write(`${t('docs.none', { id })}\n`);
    return 0;
  }
  if (!r.unnamed.length) {
    process.stdout.write(`${t('docs.ok', { id, added: r.added, commits: r.commits })}\n`);
    return 0;
  }
  process.stdout.write(`${t('docs.fail', { id, n: r.unnamed.length })}\n`);
  for (const f of r.unnamed) process.stdout.write(`  - ${f}\n`);
  process.stdout.write(`  ${t('docs.next')}\n`);
  return 1;
}

// aos preflight <ID> (ORD-0041 part 4, AMD-0015 §4): the start conditions of an order (the `preflight` checks of its
// verify file), run on the tree as it is. For a placed order or a draft. It changes no state and writes no event.
// Exit 0 when every check passes or the verify file has none; 1 with E_PREFLIGHT_FAILED; 2 on a usage error.
function cmdPreflight({ positional }, root) {
  const id = positional[0];
  if (!id) {
    process.stderr.write('usage: aos preflight <order ID>\n');
    return 2;
  }
  const t = catalog(ownerLocale(root));
  const onCheck = (c) => process.stdout.write(c.passed ? `PASS ${c.name} (exit ${c.exit})\n` : `FAIL ${c.name} (exit ${c.exit}, expected ${c.expect_exit})\n${c.detail ? `  ${c.detail}\n` : ''}`);
  try {
    const p = requirePreflight(root, id, { onCheck });
    process.stdout.write(`${p.has ? t('preflight.ok', { id, n: p.results.length, evidence: p.evidence }) : t('preflight.ok_none', { id })}\n`);
    return 0;
  } catch (x) {
    return refuse('preflight', x);
  }
}

// aos repair-log (ORD-0042 part 4): owner only, a typed word. It repairs the log only under its three conditions
// (lib/log-repair.mjs); in every other case it changes nothing and the director restores, as before.
async function cmdRepairLog(_args, root) {
  const t = catalog(ownerLocale(root));
  try {
    const r = await repairLog(root, { isTTY: process.stdin.isTTY === true, ask: askLine, out: (s) => process.stdout.write(`${s}\n`), t });
    const lines = readFileSync(logPath(root), 'utf8').split('\n').length - 1;
    process.stdout.write(`${LOG_REL}: ${lines} lines, hash chain intact\n`);
    sayOk(root, 'repair_log', { removed: r.removed, lines });
    return 0;
  } catch (x) {
    return refuse('repair-log', x);
  }
}

// aos decision record (ORD-0042 part 6): the director records the owner's decision that one or several orders
// carry out. (The owner's own placement records it by itself when the draft carries the key `decision:`.)
function cmdDecision({ opts, positional }, root) {
  const ids = opts.orders ?? [];
  if (positional[0] !== 'record' || !opts.text || !String(opts.text).trim() || !ids.length) {
    process.stderr.write('usage: aos decision record --text "<one line>" [--source <file>] --order <ID> [--order <ID> …]\n');
    return 2;
  }
  try {
    const payload = { text: String(opts.text).trim(), source: opts.source ?? null, orders: ids };
    const { line } = appendEvent(root, { type: 'decision.recorded', actor: 'director', subject: ids.length === 1 ? ids[0] : null, payload, agent: parseAgent({}) });
    process.stdout.write(`decision.recorded for ${ids.join(', ')} (${LOG_REL}:${line})\n`);
    return 0;
  } catch (x) {
    return refuse('decision record', x);
  }
}

// aos status (ORD-0042 part 6): one line per order that is not closed; aos status <ID>: the detail of one, with the
// single next step (the line of aos next) or, for a closed order, how long each stage took; --chain: the links from
// the decision to the signature, also as JSON; --metric: minutes and owner steps from the decision to the first run.
// Read from the log only. It ends with one closing line, except --json (read by a program).
function cmdStatus({ opts, positional }, root) {
  const t = catalog(ownerLocale(root));
  let events;
  try {
    events = readLog(root).events;
  } catch (x) {
    return refuse('status', x);
  }
  const orders = replay(events).orders;
  const id = positional[0];
  const stage = (state) => `${state} (${t(`queue.state.${state}`)})`;
  // ORD-0042 part 11: the work the log recorded for an order; tokens are not known to a plugin.
  const work = (o) => {
    const c = consumptionOf(events, o);
    return `  ${t('status.work', { sessions: c.sessions, runs: c.runs, minutes: c.minutes })}${c.open_run ? ` ${t('status.work_open')}` : ''}`;
  };
  const line = (s) => t('status.line', { id: s.id, stage: stage(s.state), who: s.holder.who, session: s.holder.session ? ` (${s.holder.name}, ${t('status.session', { session: s.holder.session })})` : '', why: s.why || t('status.no_reason'), since: s.since, for: span(s.for_ms) });
  if (opts.metric === true) {
    const ids = Object.keys(orders).sort();
    let have = 0;
    for (const o of ids) {
      const m = metricOf(events, o);
      if (!m) process.stdout.write(`${t('status.metric_none', { id: o })}\n`);
      else {
        have += 1;
        process.stdout.write(`${m.minutes === null ? t('status.metric_waiting', { id: o, steps: m.owner_steps, ts: m.decision }) : t('status.metric_line', { id: o, minutes: m.minutes, steps: m.owner_steps })}\n`);
      }
      process.stdout.write(`${work(o)}\n`);
    }
    sayOk(root, 'status_metric', { have, n: ids.length });
    return 0;
  }
  if (!id) {
    const open = statusOf(root, events).filter((s) => !TERMINAL.has(s.state));
    process.stdout.write(`${waitingLine(root, events, t)}\n`); // ORD-0043 part 6: who waits for whom, first
    process.stdout.write(`${t('stop.hint')}\n`); // ORD-0043 part 15: the launcher and the word
    for (const s of open) process.stdout.write(`${line(s)}\n`);
    sayOk(root, 'status', { n: open.length });
    return 0;
  }
  if (!orders[id]) return refuse('status', Object.assign(new Error(`${id} is not an order of this project (no record in the event log)`), { code: 'E_NO_ORDER' }));
  if (opts.chain === true) {
    const links = chainOf(events, id);
    if (opts.json === true) {
      process.stdout.write(`${JSON.stringify(links.map(({ link, ts }) => ({ link, ts })))}\n`);
      return 0;
    }
    const width = Math.max(...links.map((l) => l.link.length), 8);
    for (const l of links) process.stdout.write(`${l.link.padEnd(width)}  ${l.ts}${l.detail ? `  ${l.link === 'outcome' && l.detail === 'parts_cap' ? `parts_cap (${t('outcome.parts_cap')})` : l.detail}` : ''}\n`);
    sayOk(root, 'status_chain', { id, n: links.length });
    return 0;
  }
  const s = statusOf(root, events).find((x) => x.id === id);
  process.stdout.write(`${line(s)}\n`);
  if (TERMINAL.has(s.state)) process.stdout.write(`${t('status.stages', { list: stagesOf(events, id).map((x) => `${x.state} ${span(x.ms)}`).join(' · ') })}\n`);
  // ORD-0043 part 2: an order closed with checks of form waived by the owner says so.
  const waived = waiversOf(events, id);
  if (waived.length) process.stdout.write(`${t('status.waived', { n: waived.length, checks: waived.map((w) => w.check).join(', ') })}\n`);
  else process.stdout.write(`${nextLine(root, { explicit: true })}\n`);
  const m = metricOf(events, id);
  process.stdout.write(`${!m ? t('status.metric_none', { id }) : m.minutes === null ? t('status.metric_waiting', { id, steps: m.owner_steps, ts: m.decision }) : t('status.metric_line', { id, minutes: m.minutes, steps: m.owner_steps })}\n`);
  process.stdout.write(`${work(id)}\n`);
  sayOk(root, 'status_one', { id, state: s.state });
  return 0;
}

// aos replaced check <ID> (ORD-0042 part 7): at the newest commit of the order, every path of its `replaces:` list no
// longer exists. Exit 0 when it holds, or when the order has no key or an empty list (one line); 1 with the list of
// what is still there; 2 on a usage error. Meant for verify files.
function cmdReplaced({ positional }, root) {
  if (positional[0] !== 'check' || !positional[1]) {
    process.stderr.write('usage: aos replaced check <order ID>\n');
    return 2;
  }
  const t = catalog(ownerLocale(root));
  const id = positional[1];
  try {
    const r = replacedCheck(root, id);
    if (!r.key) process.stdout.write(`${t('replaced.no_key', { id })}\n`);
    else if (!r.paths.length) process.stdout.write(`${t('replaced.empty', { id })}\n`);
    else if (!r.still.length) process.stdout.write(`${t('replaced.ok', { id, n: r.paths.length, commit: r.commit.slice(0, 7) })}\n`);
    else {
      process.stdout.write(`${t('replaced.fail', { id, still: r.still.length, n: r.paths.length, commit: r.commit.slice(0, 7) })}\n`);
      for (const p of r.still) process.stdout.write(`  - ${p}\n`);
      process.stdout.write(`  ${t('replaced.next')}\n`);
      return 1;
    }
    return 0;
  } catch (x) {
    return refuse('replaced check', x);
  }
}

// aos trailer check <ID> --from <commit> (ORD-0043 part 12): every commit after <commit>, up to the newest commit of
// the order, that changes code carries the trailer of the order: the rule of the push guard, by the same function.
// Exit 0 when it holds; 1 with the commits that fail; 2 on a usage error. Meant for verify files.
function cmdTrailer({ opts, positional }, root) {
  if (positional[0] !== 'check' || !positional[1] || typeof opts.from !== 'string') {
    process.stderr.write('usage: aos trailer check <order ID> --from <commit>\n');
    return 2;
  }
  const id = positional[1];
  try {
    const r = trailerCheck(root, id, { from: opts.from });
    const range = `from ${r.from.slice(0, 7)} to ${r.to.slice(0, 7)}`;
    if (r.problems.length) {
      for (const p of r.problems) process.stdout.write(`  - ${p}\n`);
      process.stdout.write(`trailer check: ${r.problems.length} of ${r.commits} commit(s) ${range} change code without the trailer of ${id} (the rule of the push guard: a commit that touches only the log, the evidence or the director paths needs none)\n`);
      return 1;
    }
    process.stdout.write(`trailer check: ok (${r.commits} commit(s) ${range}; ${r.code} change code and carry the trailer of ${id})\n`);
    return 0;
  } catch (x) {
    return refuse('trailer check', x);
  }
}

// aos report template <ID> | aos report check <ID> (ORD-0043 part 13): the lines a report must carry come from the
// verify file (`report_lines`). `template` prints the skeleton with the fixed sections and one line per entry;
// `check` tries only those lines and the fixed sections on the report as it is: it changes no state. Exit 0 when
// nothing is missing; 1 with what is missing; 2 on a usage error.
function cmdReport({ positional }, root) {
  const [sub, id] = positional;
  if (!['template', 'check'].includes(sub) || !id) {
    process.stderr.write('usage: aos report template <order ID> | aos report check <order ID>\n');
    return 2;
  }
  try {
    if (sub === 'template') {
      process.stdout.write(reportTemplate(root, id));
      return 0;
    }
    const r = reportCheck(root, id);
    if (!r.exists) {
      process.stdout.write(`report check: there is no report at ${r.path}. Start it with: ${aosCommand()} report template ${id}\n`);
      return 1;
    }
    for (const l of r.lines) process.stdout.write(`missing line: ${missingLine(l)}\n`);
    for (const s of r.sections) process.stdout.write(`missing: ${s}\n`);
    if (r.lines.length || r.sections.length) {
      process.stdout.write(`report check: ${r.lines.length} of ${r.entries.length} line(s) missing, ${r.sections.length} fixed section(s) missing in ${r.path}. Write each one in its exact form, then run this again\n`);
      return 1;
    }
    process.stdout.write(r.entries.length
      ? `report check: ok (the ${r.entries.length} line(s) of the verify file and the fixed sections are there in ${r.path})\n`
      : `report check: ok (the fixed sections are there in ${r.path}; the verify file names no line)\n`);
    return 0;
  } catch (x) {
    return refuse(`report ${sub}`, x);
  }
}

// aos tracked <path>… (ORD-0043 part 14): one line per path, from git: under version control, ignored (by which rule of
// which file) or neither. Quote its line before stating that a file is or is not under version control.
function cmdTracked({ positional }, root) {
  if (!positional.length) {
    process.stderr.write('usage: aos tracked <path> [<path> …]\n');
    return 2;
  }
  try {
    for (const r of tracked(root, positional)) process.stdout.write(`${trackedLine(r)}\n`);
    return 0;
  } catch (x) {
    return refuse('tracked', x);
  }
}

const commands = {
  tracked: cmdTracked,
  replaced: cmdReplaced,
  report: cmdReport,
  trailer: cmdTrailer,
  status: cmdStatus,
  decision: cmdDecision,
  'repair-log': cmdRepairLog,
  preflight: cmdPreflight,
  docs: cmdDocs,
  ids: cmdIds,
  next: cmdNext,
  launchers: cmdLaunchers,
  update: cmdUpdate,
  scratch: cmdScratch,
  drafts: cmdDrafts,
  backup: cmdBackup,
  review: cmdReview,
  workflow: cmdWorkflow,
  pause: cmdPause,
  'resume-order': cmdResumeOrder, unblock: cmdUnblock,
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
