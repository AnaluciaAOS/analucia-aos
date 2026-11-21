// Guards (SPEC-0002 §4): resume at start, no silent ending, off switch, protected paths, one director, right account.
// Every refusal says what clears it and who must do it (Q-86).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { PLUGIN_DIR, accountFixes, aosCommand, githubSlug } from './cli.mjs';
import { fileURLToPath } from 'node:url';
import { derive } from './derive.mjs';
import { NOT_FOUND_EXIT, RUNNER } from './launchers.mjs';
import { resolveOrderCommit } from './verify-refs.mjs';
import { writeHandoff } from './handoff.mjs';
import { appendEvent, logPath, readLog, timestampFor, verifyChain } from './log.mjs';
import { tokenPatterns } from './secret-patterns.mjs';
import { declaredDirector } from './session-names.mjs';
import { sessionEnded, sessionStarted } from './sessions.mjs';
import { RuleError } from './state.mjs';

const toPosix = (p) => p.split(sep).join('/');
export const HALT_REL = '.analucia/HALT';
const haltPath = (root) => join(root, '.analucia', 'HALT');

// Nearest directory (from `start` upwards) that contains .analucia/. Null if none.
export function findRoot(start) {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, '.analucia'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

// ---------- Resume at start ----------

export function sessionStart(root, input = {}) {
  const out = [];
  try {
    out.push(derive(root).resume.trimEnd());
  } catch (x) {
    out.push(`Analucia: could not derive the resume (${x.code ?? 'error'}: ${x.message}). Run "aos verify-log" and tell the director.`);
  }
  if (existsSync(haltPath(root))) out.push('', `HALT: ${haltText(root)}`);
  const agent = { tool: 'claude-code' };
  if (typeof input.model === 'string') agent.model = input.model;
  if (typeof input.session_id === 'string') agent.session = input.session_id;
  try {
    // ORD-0041 part 5 (AMD-0015 §5): a session that declared the role director under this session id stays a
    // director when the hook runs again (a resume, a compaction, a clear); it is not declared executor.
    if (!declaredDirector(root, agent.session)) {
      appendEvent(root, { type: 'role.declared', actor: 'executor', subject: null, agent, payload: { role: 'executor', source: typeof input.source === 'string' ? input.source : 'startup' } });
    }
  } catch (x) {
    out.push('', `Analucia: role.declared was not recorded (${x.code}: ${x.message}).`);
  }
  // AMD-0007 §2: the session, after the resume was derived, so the new session is not shown as interrupted.
  try {
    sessionStarted(root, input);
  } catch (x) {
    out.push('', `Analucia: session.start was not recorded (${x.code}: ${x.message}).`);
  }
  return `${out.join('\n')}\n`;
}

// SessionEnd hook (AMD-0007 §2): it cannot block the end; a failure is only reported on stderr.
export function sessionEnd(root, input = {}) {
  try {
    sessionEnded(root, input);
    return null;
  } catch (x) {
    return `Analucia: session.end was not recorded (${x.code ?? 'error'}: ${x.message}).`;
  }
}

// ---------- No silent ending ----------

export function openRuns(events) {
  const open = new Map();
  const taken = new Map();
  for (const e of events) {
    if (!e.subject) continue;
    if (e.type === 'run.started') { open.set(e.subject, e); taken.delete(e.subject); }
    if (e.type === 'run.finished') open.delete(e.subject);
    // ORD-0043 part 5: `aos run take` changes the owner session of the open run.
    if (e.type === 'operation.logged' && e.payload?.operation === 'run.take' && open.has(e.subject) && typeof e.payload.session === 'string') taken.set(e.subject, e.payload.session);
  }
  // ORD-0041 part 5: the session that started the run, when run.started recorded one (or the one that took it).
  return [...open.entries()].map(([id, e]) => ({ id, run: e.payload?.run ?? null, session: taken.get(id) ?? (typeof e.agent?.session === 'string' && e.agent.session ? e.agent.session : null) }));
}

// Returns null when it is safe to stop, else the message that explains how to clear the block.
// ORD-0041 part 5 (AMD-0015 §5): `input` is the hook input. Only the session that owns an open run is blocked by it.
// Another session, and a session that declared the role director, end freely: checkWritebackNote says which order
// has a run open and where. With no session in the input, or a run with no recorded owner, every session is
// blocked as before. A broken log blocks every session.
const hookSession = (input) => (typeof input?.session_id === 'string' && input.session_id ? input.session_id : null);
function runsFor(root, input) {
  const events = readLog(root).events;
  const runs = openRuns(events);
  const session = hookSession(input);
  if (!session) return { mine: runs, others: [] };
  if (declaredDirector(root, session, events)) return { mine: [], others: runs };
  return { mine: runs.filter((r) => !r.session || r.session === session), others: runs.filter((r) => r.session && r.session !== session) };
}

// One line per run that is open in another session, or null. Never a block.
export function checkWritebackNote(root, input = {}) {
  if (!existsSync(logPath(root)) || verifyChain(readFileSync(logPath(root)))) return null;
  const { mine, others } = runsFor(root, input);
  if (mine.length || !others.length) return null;
  return others.map(({ id, run, session }) => `Analucia: run ${run ?? '?'} of ${id} is open ${session ? `in another session (${session})` : 'with no recorded session'}; this session may end.`).join('\n');
}

export function checkWriteback(root, input = {}) {
  if (!existsSync(logPath(root))) return null;
  const broken = verifyChain(readFileSync(logPath(root)));
  if (broken) {
    return `Analucia: the event log is broken at .analucia/events.jsonl line ${broken.line} (${broken.code}: ${broken.message}). `
      + 'Do not edit the log. If only session lines that were not committed are affected, the owner repairs it with REPARAR ("aos repair-log"); otherwise the director restores it from git and confirms with "aos verify-log" before anyone continues.';
  }
  const runs = runsFor(root, input).mine;
  if (!runs.length) return null;
  return runs.map(({ id, run }) => `Analucia: run ${run ?? '?'} of ${id} is still open. Before ending, the executor records its outcome: `
    + `aos run finish ${id} --outcome <done|blocked|needs_decision|budget_exhausted|parts_cap|failed> --evidence .analucia/evidence/${id}/report.md`).join('\n');
}

// ORD-0043 part 1 (OBS-164): a compaction is never blocked: compacting does not end a run. What the PreCompact hook
// says, or null: with a run open in this session, which order it is and that the handoff was written; a broken log
// only warns. Never a block.
export function compactNote(root, input = {}) {
  if (!existsSync(logPath(root))) return null;
  const broken = verifyChain(readFileSync(logPath(root)));
  if (broken) {
    return `Analucia: the event log is broken at .analucia/events.jsonl line ${broken.line} (${broken.code}); compacting is not blocked. `
      + 'Do not edit the log: the owner repairs it with REPARAR ("aos repair-log") or the director restores it from git.';
  }
  const { mine, others } = runsFor(root, input);
  if (!mine.length) return others.length ? checkWritebackNote(root, input) : null;
  return mine.map(({ id, run }) => {
    let written = null;
    try { written = writeHandoff(root, id, { by: 'the PreCompact hook' }); } catch { written = null; }
    return `Analucia: run ${run ?? '?'} of ${id} is open in this session; compacting does not end it. `
      + (written ? `The handoff was written: ${written}. ` : 'The handoff could not be written. ')
      + `After the compaction go on with the order, or finish the run: aos run finish ${id} --outcome <outcome> --evidence .analucia/evidence/${id}/report.md`;
  }).join('\n');
}

// ---------- Off switch ----------

function haltText(root) {
  try {
    const h = JSON.parse(readFileSync(haltPath(root), 'utf8'));
    return `halted by the owner since ${h.since}: ${h.reason}`;
  } catch {
    return 'halted by the owner';
  }
}

const needsOwnerTTY = (isTTY, what) => {
  if (!isTTY) throw new RuleError('E_OWNER_TTY', `"aos ${what}" needs the owner at an interactive terminal; stdin is not a TTY (agents cannot ${what}). The owner runs it in their own terminal`);
};

// ORD-0043 part 15: the one function that writes the halt: `aos halt` calls it after its terminal check, and the
// prompt hook calls it when the owner's prompt is exactly a stop word. False when the project is already halted.
export function writeHalt(root, { reason, now = new Date() }) {
  if (existsSync(haltPath(root))) return false;
  // The switch must work even if the log cannot be written: create HALT first, then log.
  writeFileSync(haltPath(root), `${JSON.stringify({ reason, since: timestampFor(root, now), by: 'owner' })}\n`);
  appendEvent(root, { type: 'operation.logged', actor: 'owner', subject: null, payload: { operation: 'halt', reason } }, { now });
  return true;
}

export function halt(root, { reason, isTTY, now = new Date() }) {
  needsOwnerTTY(isTTY, 'halt');
  if (!reason || !reason.trim()) throw new RuleError('E_MISSING_FIELD', 'usage: aos halt --reason "<text>"');
  if (existsSync(haltPath(root))) throw new RuleError('E_TRANSITION', `already ${haltText(root)}`);
  writeHalt(root, { reason, now });
}
export const isHalted = (root) => existsSync(haltPath(root));

export function resume(root, { isTTY, now = new Date() }) {
  needsOwnerTTY(isTTY, 'resume');
  if (!existsSync(haltPath(root))) throw new RuleError('E_TRANSITION', 'not halted: .analucia/HALT does not exist');
  rmSync(haltPath(root));
  appendEvent(root, { type: 'operation.logged', actor: 'owner', subject: null, payload: { operation: 'resume' } }, { now });
}

// ---------- PreToolUse: HALT and protected paths ----------

export const READ_TOOLS = ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead'];
const FILE_TOOLS = { Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' };
const SHELL_TOOLS = ['Bash', 'PowerShell'];

export function isProtected(rel) {
  const p = process.platform === 'win32' ? rel.toLowerCase() : rel;
  const l = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
  return p === l('.analucia/HALT') || p === l('.analucia/director.lock')
    || ['.analucia/orders/', '.analucia/amendments/', '.analucia/verify/', '.analucia/rollback/', '.analucia/asks/'].some((d) => p.startsWith(l(d)))
    || /^core\/[^/]+\.md$/i.test(p);
}

// Repo-relative posix path of a tool path, or null when it is outside the repo.
export function repoRelative(root, p) {
  if (typeof p !== 'string' || !p) return null;
  let q = p.replace(/\\/g, '/');
  if (process.platform === 'win32' && /^\/[a-zA-Z]\//.test(q)) q = `${q[1]}:${q.slice(2)}`; // /c/x -> c:/x (Git Bash)
  const abs = isAbsolute(q) ? resolve(q) : resolve(root, q);
  const rel = toPosix(relative(root, abs));
  return rel.startsWith('..') || isAbsolute(rel) ? null : rel;
}

// Protected paths mentioned in a shell command (repo-relative or absolute).
const SHELL_PATH_RES = [
  /(?:[A-Za-z]:)?[^\s'"`;|&<>()]*\.analucia\/(?:HALT\b|director\.lock|(?:orders|amendments|verify|rollback|asks)\/[^\s'"`;|&<>()]*)/gi,
  /(?:[A-Za-z]:)?[^\s'"`;|&<>()]*(?<!plugins\/analucia\/)(?<![\w.-])core\/[^\s'"`;|&<>()/]+\.md\b/gi,
];
// Write operators other than redirection: a command that uses one AND names a protected path is blocked.
const WRITE_RE = new RegExp([
  '\\b(?:rm|rmdir|mv|cp|tee|touch|truncate|dd|ln|chmod|chown|install|unlink|shred)\\b',
  '\\b(?:sed|perl)\\b[^|;&]*\\s-i',
  '\\bgit\\s+(?:checkout|restore|rm|mv|reset|stash|clean|apply|am)\\b',
  '\\b(?:Remove-Item|Set-Content|Add-Content|Out-File|Move-Item|Copy-Item|New-Item|Rename-Item|Clear-Content|del|erase|ren)\\b',
  '\\b(?:writeFile|appendFile|unlink|rmSync|rm|copyFile|rename)(?:Sync)?\\s*\\(',
].join('|'), 'i');
const HARMLESS_RE = /\d*>&\d+|&>\s*\/dev\/null|\d?>\s*\/dev\/null|\|\s*Out-Null|\d?>\s*\$null/gi;
// Heredoc bodies are data written to the command's own target, not paths the command acts on.
const HEREDOC_RE = /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1[^\n]*\n[\s\S]*?\n\2(?=\s|$)/g;
// A redirection and its target: > file, >> file, > "file", >| file (after the harmless forms are stripped).
const REDIRECT_RE = /(?:^|[^<>=-])\d?>{1,2}\|?\s*("[^"]*"|'[^']*'|[^\s;|&()<>]+)/g;

const protectedHits = (root, text) => {
  const hits = new Set();
  for (const re of SHELL_PATH_RES) {
    for (const m of text.matchAll(re)) {
      const rel = repoRelative(root, m[0]) ?? m[0].replace(/^.*?(\.analucia\/|core\/)/i, '$1');
      if (isProtected(rel)) hits.add(rel);
    }
  }
  return hits;
};

// ORD-0012: a redirection is judged by its target. `cat <protected> > /tmp/x` reads a protected file and is
// allowed; `… > <protected>` writes one and is blocked. Every other write operator keeps the conservative rule
// (it names a protected path anywhere in the command → blocked).
export function shellTouchesProtected(root, command) {
  const cmd = String(command ?? '').replace(/\\/g, '/').replace(HARMLESS_RE, ' ').replace(HEREDOC_RE, '<<$1$2$1');
  const blocked = new Set();
  for (const m of cmd.matchAll(REDIRECT_RE)) {
    const target = m[1].replace(/^["']|["']$/g, '');
    for (const h of protectedHits(root, target)) blocked.add(h);
    const rel = repoRelative(root, target);
    if (rel && isProtected(rel)) blocked.add(rel);
  }
  // The command without its redirections (operator and target), for the other write operators.
  const rest = cmd.replace(REDIRECT_RE, (s) => `${s.slice(0, s.indexOf('>'))} `);
  if (WRITE_RE.test(rest)) for (const h of protectedHits(root, rest)) blocked.add(h);
  return [...blocked];
}

// ORD-0043 part 10 (OBS-151): one director per project. A path inside a `.analucia/` folder that is not under this
// project's root belongs to another project: nobody writes or deletes there from a session of this one.
const ANALUCIA_PATH_RE = /(?:[A-Za-z]:)?[^\s'"`;|&<>()]*\.analucia(?:\/[^\s'"`;|&<>()]*)?/gi;
function inOtherProject(root, p) {
  if (typeof p !== 'string' || !p) return null;
  let q = p.replace(/\\/g, '/');
  if (process.platform === 'win32' && /^\/[a-zA-Z]\//.test(q)) q = `${q[1]}:${q.slice(2)}`; // /c/x -> c:/x (Git Bash)
  const abs = toPosix(isAbsolute(q) ? resolve(q) : resolve(root, q));
  if (!/(?:^|\/)\.analucia(?:\/|$)/i.test(abs)) return null;
  return repoRelative(root, abs) === null ? abs : null;
}
// The paths a tool call would write or delete inside the `.analucia/` of another project. Reading is never listed:
// a redirection is judged by its target, and the other write operators by the paths the command names.
export function otherProjectPaths(root, input = {}) {
  const tool = input.tool_name ?? '';
  const ti = input.tool_input ?? {};
  const hits = new Set();
  const add = (p) => { const abs = inOtherProject(root, p); if (abs) hits.add(abs); };
  if (FILE_TOOLS[tool]) add(ti[FILE_TOOLS[tool]]);
  else if (SHELL_TOOLS.includes(tool)) {
    const cmd = String(ti.command ?? '').replace(/\\/g, '/').replace(HARMLESS_RE, ' ').replace(HEREDOC_RE, '<<$1$2$1');
    for (const m of cmd.matchAll(REDIRECT_RE)) add(m[1].replace(/^["']|["']$/g, ''));
    const rest = cmd.replace(REDIRECT_RE, (s) => `${s.slice(0, s.indexOf('>'))} `);
    if (WRITE_RE.test(rest)) for (const m of rest.matchAll(ANALUCIA_PATH_RE)) add(m[0]);
  }
  return [...hits];
}

// ORD-0043 part 14 (OBS-171): the files only the owner writes. `owner_data` in project.json lists path patterns,
// relative to the project root: `*` stops at a slash, `**` does not, `?` is one character; a pattern with no slash
// names a file at any depth (`rates.*`). An agent never writes or deletes such a file; reading stays free.
function globRe(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, process.platform === 'win32' ? 'i' : '');
}
export function matchesOwnerData(patterns, rel) {
  const path = String(rel).replace(/\\/g, '/').replace(/^\.\//, '');
  return (patterns ?? []).some((raw) => {
    const pattern = String(raw).replace(/\\/g, '/').replace(/^\.\//, '');
    if (!pattern) return false;
    return globRe(pattern.includes('/') ? pattern : `**/${pattern}`).test(path);
  });
}
const ownerDataPatterns = (root) => {
  const list = projectOf(root).owner_data;
  return Array.isArray(list) ? list.filter((s) => typeof s === 'string' && s.trim()) : [];
};
// The paths (relative to the root) that a tool call would write or delete and that match owner_data.
export function ownerDataPaths(root, input = {}) {
  const patterns = ownerDataPatterns(root);
  if (!patterns.length) return [];
  const tool = input.tool_name ?? '';
  const ti = input.tool_input ?? {};
  const hits = new Set();
  const add = (p) => {
    const rel = repoRelative(root, String(p ?? '').replace(/^["']|["']$/g, ''));
    if (rel && matchesOwnerData(patterns, rel)) hits.add(rel);
  };
  if (FILE_TOOLS[tool]) add(ti[FILE_TOOLS[tool]]);
  else if (SHELL_TOOLS.includes(tool)) {
    const cmd = String(ti.command ?? '').replace(/\\/g, '/').replace(HARMLESS_RE, ' ').replace(HEREDOC_RE, '<<$1$2$1');
    for (const m of cmd.matchAll(REDIRECT_RE)) add(m[1]);
    const rest = cmd.replace(REDIRECT_RE, (s) => `${s.slice(0, s.indexOf('>'))} `);
    if (WRITE_RE.test(rest)) for (const word of rest.split(/[\s'"`;|&()<>,=]+/)) if (word) add(word);
  }
  return [...hits];
}

// Returns null to allow, or the message to block with.
export function preToolUse(root, input = {}) {
  const tool = input.tool_name ?? '';
  const ti = input.tool_input ?? {};
  if (existsSync(haltPath(root)) && !READ_TOOLS.includes(tool)) {
    return `Analucia is ${haltText(root)}. Only reads (${READ_TOOLS.join(', ')}) are allowed; "${tool}" is blocked. `
      + 'Stop and wait: the owner lifts the halt by running "aos resume" in their own terminal. Agents cannot.';
  }
  const others = otherProjectPaths(root, input);
  if (others.length) {
    return `Analucia: blocked ${tool} on ${others.join(', ')}: E_OTHER_PROJECT the path is inside the .analucia/ folder of another project. `
      + 'One director per project: open a session in that project and write it there. Reading stays free.';
  }
  const owned = ownerDataPaths(root, input);
  if (owned.length) {
    return `Analucia: blocked ${tool} on ${owned.join(', ')}: E_OWNER_DATA the path is a file only the owner writes (owner_data in .analucia/project.json). `
      + 'Tell the owner what should change and why; reading stays free.';
  }
  let paths = [];
  if (FILE_TOOLS[tool]) {
    const rel = repoRelative(root, ti[FILE_TOOLS[tool]]);
    if (rel && isProtected(rel)) paths = [rel];
  } else if (SHELL_TOOLS.includes(tool)) {
    paths = shellTouchesProtected(root, ti.command);
  }
  if (!paths.length) return null;
  return `Analucia: blocked ${tool} on ${paths.join(', ')}: a protected path (SPEC-0002 §4). `
    + 'Orders, amendments, verify files, rollback plans, asks, core specs and director.lock are written only by the director, who then refreshes .analucia/director.lock; '
    + '.analucia/HALT is changed only by the owner with "aos halt" / "aos resume". '
    + 'The executor never edits them: if one must change, finish the run with "aos run finish <ORD> --outcome needs_decision" and ask the director.';
}

// ---------- One director: AGENTS.md block and roles check ----------

export const BEGIN = '<!-- analucia:begin -->';
export const END = '<!-- analucia:end -->';
const TEMPLATE_PATH = fileURLToPath(new URL('../core/AGENTS.block.md', import.meta.url));
// ORD-0029 B (OBS-106): in a project that is not the plugin's own repository, plugins/analucia/ does not exist, so the
// block names the CLI and the docs by the absolute path of the installed plugin. Without a root: the block as written.
export const blockTemplate = (root) => {
  const text = readFileSync(TEMPLATE_PATH, 'utf8').replace(/\r\n/g, '\n');
  if (!root || existsSync(join(root, 'plugins', 'analucia', 'bin', 'aos.mjs'))) return text;
  return text.split('node plugins/analucia/bin/aos.mjs').join(aosCommand()).split('`plugins/analucia/').join(`\`${PLUGIN_DIR}/`);
};
const count = (s, sub) => s.split(sub).length - 1;

export function agentsMdSync(root, { dryRun = false } = {}) {
  const p = join(root, 'AGENTS.md');
  const existed = existsSync(p);
  const original = existsSync(p) ? readFileSync(p, 'utf8') : '';
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const text = original.replace(/\r\n/g, '\n');
  const nb = count(text, BEGIN);
  const ne = count(text, END);
  if (nb > 1 || ne > 1 || nb !== ne || (nb === 1 && text.indexOf(BEGIN) > text.indexOf(END))) {
    throw new RuleError('E_ROLES', `AGENTS.md has ${nb} "${BEGIN}" and ${ne} "${END}" markers; it needs exactly one pair. Fix it by hand (keep one block), then run "aos agents-md sync"`);
  }
  const block = `${BEGIN}\n${blockTemplate(root)}${END}`;
  let next;
  if (nb === 1) {
    next = text.slice(0, text.indexOf(BEGIN)) + block + text.slice(text.indexOf(END) + END.length);
  } else if (text.trim() === '') {
    next = `# AGENTS.md\n\n${block}\n`;
  } else {
    next = `${text.endsWith('\n') ? text : `${text}\n`}\n${block}\n`;
  }
  next = next.replace(/\n/g, eol);
  const changed = next !== original;
  if (changed && !dryRun) writeFileSync(p, next);
  const c = join(root, 'CLAUDE.md');
  let claudeCreated = false;
  if (!existsSync(c)) {
    if (!dryRun) writeFileSync(c, '@AGENTS.md\n');
    claudeCreated = true;
  }
  return { changed, created: changed && !existed, claudeCreated };
}

// The lines of a CLAUDE.md that are director instructions (the E_ROLES conflict): anything but the import line
// that names the director or carries a marker of the Analucia block. One definition, shared by check-roles, the
// plan of aos init and aos init --check (AMD-0013 Change 1).
export function directorLines(text) {
  return String(text).replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim() !== '@AGENTS.md' && (/\bdirector\b/i.test(l) || l.includes(BEGIN) || l.includes(END)));
}

export function checkRoles(root) {
  const problems = [];
  const a = join(root, 'AGENTS.md');
  if (!existsSync(a)) problems.push('AGENTS.md is missing: run "aos agents-md sync"');
  else {
    const text = readFileSync(a, 'utf8').replace(/\r\n/g, '\n');
    const nb = count(text, BEGIN);
    const ne = count(text, END);
    if (nb === 0 && ne === 0) problems.push('AGENTS.md has no analucia block: run "aos agents-md sync"');
    else if (nb !== 1 || ne !== 1 || text.indexOf(BEGIN) > text.indexOf(END)) problems.push(`AGENTS.md has ${nb} begin and ${ne} end markers (duplicated or broken block): keep exactly one, then run "aos agents-md sync"`);
    else {
      const inner = text.slice(text.indexOf(BEGIN) + BEGIN.length + 1, text.indexOf(END));
      if (inner !== blockTemplate(root)) problems.push('the analucia block in AGENTS.md differs from the plugin rules: run "aos agents-md sync" (edits belong outside the block)');
    }
  }
  const c = join(root, 'CLAUDE.md');
  if (!existsSync(c)) problems.push('CLAUDE.md is missing: it must contain the line "@AGENTS.md" (run "aos agents-md sync")');
  else {
    const lines = readFileSync(c, 'utf8').replace(/\r\n/g, '\n').split('\n');
    if (!lines.some((l) => l.trim() === '@AGENTS.md')) problems.push('CLAUDE.md does not import "@AGENTS.md": add that line');
    const director = directorLines(lines.join('\n'));
    if (director.length) problems.push(`CLAUDE.md contains director instructions (${director.length} line(s), e.g. ${JSON.stringify(director[0].trim().slice(0, 60))}); the executor entrypoint holds only "@AGENTS.md". Move them to the director's own entrypoint: the owner double-clicks INICIAR ("aos init"), whose plan moves the whole file to CLAUDE.previous.md after CONFIRM`);
  }
  // AMD-0007 §1: a review decision written by anyone but the owner (for example by hand, with a valid chain).
  if (existsSync(logPath(root))) {
    try {
      readLog(root).events.forEach((e, i) => {
        if (e.type === 'review.decision' && e.actor !== 'owner') problems.push(`.analucia/events.jsonl line ${i + 1}: review.decision by actor ${e.actor}; only the owner decides a review (in "aos sign"). The director reports it to the owner`);
      });
    } catch { /* a broken log is reported by aos verify-log */ }
  }
  return problems;
}

// ---------- Right account ----------

const git = (root, args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });

export function urlUser(url) {
  try {
    const u = new URL(url);
    return u.username ? decodeURIComponent(u.username) : null;
  } catch {
    const m = /^([^@/:\s]+)@[^:]+:/.exec(url); // scp-like ssh: git@github.com:owner/repo.git
    return m ? m[1] : null;
  }
}

// A URL with its password replaced, so a message can name the remote without leaking the secret.
const redactUrl = (u) => u.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/:@]*):[^@/]*@/i, '$1:***@');
const urlHasSecret = (u) => {
  try {
    return new URL(u).password !== '';
  } catch {
    return false;
  }
};

// SPEC-0004 §4: owner and director paths; commits that only touch these need no Analucia-Order trailer.
export const OWNER_DIRECTOR_PATHS = [
  '.analucia/events.jsonl', '.analucia/evidence/**', '.analucia/orders/**', '.analucia/amendments/**', '.analucia/verify/**',
  '.analucia/asks/**', '.analucia/rollback/**', '.analucia/director.lock', 'core/*.md',
];
export const isOwnerDirectorPath = (p) => p === '.analucia/events.jsonl' || p === '.analucia/director.lock'
  || ['.analucia/evidence/', '.analucia/orders/', '.analucia/amendments/', '.analucia/verify/', '.analucia/asks/', '.analucia/rollback/'].some((d) => p.startsWith(d))
  || /^core\/[^/]+\.md$/.test(p);

const TRAILER_RE = /^Analucia-Order:[ \t]*(\S+)[ \t]*$/gm;
export const orderTrailers = (message) => [...message.matchAll(TRAILER_RE)].map((m) => m[1]);

// The token patterns now live in lib/secret-patterns.mjs, shared with the adoption audit (ORD-0016).
// core/secret-patterns.json stays as a generated mirror for existing readers; a test keeps the two equal.
export const secretPatterns = tokenPatterns;

// The commits being pushed: <remote>/<branch>..HEAD (or everything not yet on the remote for a new branch).
export function pushedCommits(root, remote = 'origin') {
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  const base = `refs/remotes/${remote}/${branch}`;
  const hasBase = git(root, ['rev-parse', '--verify', '-q', base]).status === 0;
  const args = hasBase ? ['rev-list', '--reverse', `${base}..HEAD`] : ['rev-list', '--reverse', 'HEAD', '--not', `--remotes=${remote}`];
  const r = git(root, args);
  return { range: hasBase ? `${remote}/${branch}..HEAD` : `HEAD (not on ${remote})`, commits: r.status === 0 ? r.stdout.split('\n').filter(Boolean) : [] };
}

// Added lines of one commit, with their file and line number in the new version.
function addedLines(root, sha) {
  const r = git(root, ['show', '--format=', '--unified=0', '--no-color', '--no-ext-diff', '-m', '--first-parent', sha]);
  const out = [];
  let file = null;
  let line = 0;
  for (const l of r.stdout.split('\n')) {
    if (l.startsWith('+++ ')) { file = l === '+++ /dev/null' ? null : l.replace(/^\+\+\+ b\//, ''); continue; }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) { line = Number(h[1]); continue; }
    if (file && l.startsWith('+')) { out.push({ file, line, text: l.slice(1) }); line++; }
  }
  return out;
}

// ORD-0043 part 12 (OBS-168): the one trailer rule, called by the push guard (aos check-push) and by
// `aos trailer check`. A commit that changes code (any path outside the owner and director paths) carries an order
// trailer; a commit that touches only the log, the evidence or the director paths needs none.
// `started`: the orders that have a run.started in the log (the guard: a trailer must name one of them).
// `order`: the one order whose trailer every code commit must carry (the check of a verify file).
// Returns { trailers: [one line per commit that fails], code: [sha of each commit that changes code], valid: Map sha -> ids }.
export function trailerProblems(root, commits, { started = null, order = null } = {}) {
  const trailers = [];
  const code = [];
  const valid = new Map();
  for (const sha of commits) {
    const short = sha.slice(0, 7);
    const paths = git(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', '-m', '--first-parent', sha]).stdout.split('\n').filter(Boolean);
    const outside = paths.filter((p) => !isOwnerDirectorPath(p));
    if (!outside.length) continue;
    code.push(sha);
    const what = `${short} changes ${outside[0]}${outside.length > 1 ? ` (+${outside.length - 1} more)` : ''}`;
    const ids = orderTrailers(git(root, ['log', '-1', '--format=%B', sha]).stdout);
    const ok = ids.filter((id) => (order ? id === order : !started || started.has(id)));
    valid.set(sha, ok);
    if (!ids.length) trailers.push(`${what} but has no "Analucia-Order: ${order ?? 'ORD-NNNN'}" trailer`);
    else if (order && !ok.length) trailers.push(`${what} and carries the trailer of ${ids.join(', ')}, not of ${order}`);
    else if (!ok.length) trailers.push(`${short} names ${ids.join(', ')} in its trailer, but no such order has a run.started in the log`);
  }
  return { trailers, code, valid };
}

// aos trailer check <ID> --from <commit>: every commit after <commit>, up to the newest commit of the order, that
// changes code carries the trailer of the order. Meant for verify files; it reads git only and changes nothing.
export function trailerCheck(root, id, { from } = {}) {
  if (!from) throw new RuleError('E_MISSING_FIELD', 'usage: aos trailer check <order ID> --from <commit>');
  const base = git(root, ['rev-parse', '--verify', '-q', `${from}^{commit}`]);
  if (base.status !== 0) throw new RuleError('E_FILE_MISSING', `the commit ${JSON.stringify(from)} of --from does not exist in this repository`);
  const to = resolveOrderCommit(root, id);
  if (!to) throw new RuleError('E_NO_ORDER_COMMIT', `no commit has the trailer line "Analucia-Order: ${id}": there is nothing to check yet`);
  const commits = git(root, ['rev-list', '--reverse', `${base.stdout.trim()}..${to}`]).stdout.split('\n').filter(Boolean);
  const { trailers, code } = trailerProblems(root, commits, { order: id });
  return { from: base.stdout.trim(), to, commits: commits.length, code: code.length, problems: trailers };
}

function commitChecks(root, commits) {
  const started = new Set();
  const open = new Set();
  const finished = new Map();
  const late = [];
  const logFile = join(root, '.analucia', 'events.jsonl');
  if (existsSync(logFile)) {
    for (const l of readFileSync(logFile, 'utf8').split('\n')) {
      try {
        const e = JSON.parse(l);
        if (e.type === 'run.started') { started.add(e.subject); open.add(e.subject); }
        // ORD-0041 part 8 (AMD-0015 §6): the last run.finished of each order, and whether a run of it is open now.
        if (e.type === 'run.finished') { open.delete(e.subject); finished.set(e.subject, e.ts); }
      } catch { /* blank line */ }
    }
  }
  const patterns = secretPatterns();
  const { trailers, valid: validOf } = trailerProblems(root, commits, { started });
  const secrets = [];
  for (const sha of commits) {
    const short = sha.slice(0, 7);
    if (validOf.has(sha)) {
      const valid = validOf.get(sha);
      // ORD-0041 part 8: a commit of an order dated after its last run.finished, while no run of it is open, is work
      // outside any run. Commits that touch only owner and director paths (the sign-off) never reach this point.
      const when = Number(git(root, ['log', '-1', '--format=%ct', sha]).stdout.trim()) * 1000;
      for (const id of valid) {
        const end = finished.get(id);
        if (end && !open.has(id) && when > Date.parse(end)) late.push(`${short} carries the trailer of ${id} and is dated after its last run.finished (${end})`);
      }
    }
    for (const a of addedLines(root, sha)) {
      for (const p of patterns) if (p.re.test(a.text)) secrets.push(`${short} ${a.file}:${a.line} matches ${p.name}`);
    }
  }
  return { trailers, secrets, late };
}

const fail = (code, message, problems) => Object.assign(new RuleError(code, message), { problems });

// ---------- The push account of each remote (ORD-0042 part 5) ----------

const projectOf = (root) => {
  try { return JSON.parse(readFileSync(join(root, '.analucia', 'project.json'), 'utf8')); } catch { return {}; }
};
// The account a remote pushes as: its entry in push_accounts, else the account of the project. Null when the
// project names no account (or works without GitHub: "none").
export function accountOf(root, remote, project = projectOf(root)) {
  const a = project.push_accounts?.[remote] ?? project.github_owner;
  return typeof a === 'string' && a && a !== 'none' ? a : null;
}
// The credential user git would use for a URL, read from the repository's configuration (most specific entry).
const credentialUser = (root, remoteUrl) => {
  const r = git(root, ['config', '--get-urlmatch', 'credential.username', remoteUrl]);
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
};
const isHttpsGithub = (u) => /^https:\/\/([^@/]*@)?github\.com\//i.test(u) && Boolean(githubSlug(u));

// The remotes an order may push to: origin, and every remote named in push_accounts that exists.
function pushRemotes(root, project) {
  const have = git(root, ['remote']).stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  return ['origin', ...Object.keys(project.push_accounts ?? {})].filter((r, i, all) => all.indexOf(r) === i && have.includes(r));
}

// The remotes the built-in preflight check judges: HTTPS GitHub remotes of a project that names an account.
export function pushAccountRemotes(root) {
  const project = projectOf(root);
  return pushRemotes(root, project).filter((remote) => {
    const remoteUrl = git(root, ['remote', 'get-url', remote]).stdout.trim();
    return accountOf(root, remote, project) && isHttpsGithub(remoteUrl) && !urlHasSecret(remoteUrl);
  });
}

// [{ remote, account, user, cred }] for every HTTPS GitHub remote whose URL user or credential user is not the
// account of that remote. Empty when all is right, or when the project names no account.
export function pushAccountProblems(root) {
  const project = projectOf(root);
  const out = [];
  for (const remote of pushRemotes(root, project)) {
    const account = accountOf(root, remote, project);
    const remoteUrl = git(root, ['remote', 'get-url', remote]).stdout.trim();
    if (!account || !isHttpsGithub(remoteUrl) || urlHasSecret(remoteUrl)) continue;
    const same = (v) => typeof v === 'string' && v.toLowerCase() === account.toLowerCase();
    const user = urlUser(remoteUrl);
    const cred = credentialUser(root, remoteUrl);
    if (!(same(user) && same(cred))) out.push({ remote, account, user, cred });
  }
  return out;
}

// Writes, in the repository's own configuration only, the user of the remote URL and the credential user of each
// remote's account. Never the global configuration, never a credential. Returns the remotes it fixed.
export function fixPushAccounts(root, { dryRun = false } = {}) {
  const problems = pushAccountProblems(root);
  if (dryRun) return problems;
  for (const { remote, account } of problems) {
    const slug = githubSlug(git(root, ['remote', 'get-url', remote]).stdout.trim());
    git(root, ['remote', 'set-url', remote, `https://${account}@github.com/${slug.owner}/${slug.repo}.git`]);
    git(root, ['config', '--local', `credential.https://${account}@github.com.username`, account]);
    if (remote === 'origin') git(root, ['config', '--local', 'credential.https://github.com.username', account]);
  }
  return problems;
}

// ORD-0043 part 16 (OBS-177): the second lock. Inside an agent session (Claude Code sets CLAUDECODE in the commands it
// runs) a push to a protected branch is refused, unless it is the owner's sign-off: `aos sign` runs its pushes with
// AOS_OWNER_PUSH=1. The remote refs come from the pre-push hook's standard input ("<local ref> <local sha> <remote ref>
// <remote sha>" per line). Protected: `protected_branches` of project.json, else main and master.
export const inAgentSession = (env = process.env) => Boolean(env.CLAUDECODE || env.CLAUDE_CODE_SESSION_ID);
export function parsePushRefs(text) {
  return String(text ?? '').split('\n').map((l) => l.trim().split(/\s+/)).filter((f) => f.length >= 3 && /^refs\//.test(f[2])).map((f) => f[2]);
}
export function protectedPushProblems(root, refs) {
  const project = projectOf(root);
  const protectedNames = Array.isArray(project.protected_branches) && project.protected_branches.every((b) => typeof b === 'string') ? project.protected_branches : ['main', 'master'];
  return refs.filter((r) => protectedNames.some((b) => r === `refs/heads/${b}`));
}

export function checkPush(root, { remote = 'origin', url, refs = [], env = process.env } = {}) {
  const pj = join(root, '.analucia', 'project.json');
  const project = existsSync(pj) ? JSON.parse(readFileSync(pj, 'utf8')) : {};
  // ORD-0042 part 5: each push is checked against the account of its remote (push_accounts, else github_owner).
  const owner = project.github_owner ? (project.push_accounts?.[remote] ?? project.github_owner) : undefined;
  const named = project.push_accounts?.[remote] ? `push_accounts.${remote}` : 'project github_owner';
  if (!owner) throw new RuleError('E_ACCOUNT', `push refused: .analucia/project.json has no "github_owner". The owner sets it by answering the GitHub account question of: ${aosCommand()} init`);
  const remoteUrl = url ?? git(root, ['remote', 'get-url', remote]).stdout.trim();
  // SPEC-0004 §5: a credential in the remote URL is refused, and never printed.
  if (remoteUrl && urlHasSecret(remoteUrl)) {
    const slug = githubSlug(remoteUrl) ?? { owner, repo: basename(resolve(root)) };
    throw new RuleError('E_SECRET_IN_URL', `push refused: the URL of remote "${remote}" carries a credential (${redactUrl(remoteUrl)}). The owner removes it: git remote set-url ${remote} https://${owner}@github.com/${slug.owner}/${slug.repo}.git, then rotates that credential`);
  }
  const user = remoteUrl ? urlUser(remoteUrl) : null;
  const cred = (remoteUrl ? credentialUser(root, remoteUrl) : null) ?? (git(root, ['config', '--get', 'credential.https://github.com.username']).stdout.trim() || null);
  const same = (v) => typeof v === 'string' && v.toLowerCase() === owner.toLowerCase();
  if (!(same(user) && same(cred))) {
    const fixes = accountFixes({ owner, user, cred, url: remoteUrl, remote, folder: basename(resolve(root)) });
    throw new RuleError('E_ACCOUNT', `push refused: remote "${remote}" URL user is ${JSON.stringify(user)}, credential.https://github.com.username is ${JSON.stringify(cred)}, `
      + `${named} is "${owner}". The owner runs, in this repo: ${fixes.join(' ; then: ')}; then push again (or, for every remote at once: ${aosCommand()} install-git-hooks)`);
  }
  const toProtected = inAgentSession(env) && env.AOS_OWNER_PUSH !== '1' ? protectedPushProblems(root, refs) : [];
  if (toProtected.length) throw new RuleError('E_PROTECTED_PUSH', `push refused: this push inside an agent session updates the protected branch ${toProtected.map((r) => r.replace('refs/heads/', '')).join(', ')}. An agent pushes the branch of its order; the owner brings work to the protected branch (the step to main of "aos sign", at their own terminal)`);
  // SPEC-0004 §4–§5: every commit being pushed.
  const { range, commits } = pushedCommits(root, remote);
  const { trailers, secrets, late } = commitChecks(root, commits);
  if (secrets.length) throw fail('E_SECRET', `push refused: ${secrets.length} added line(s) in ${range} match a secret pattern (values not shown)`, secrets);
  if (trailers.length) throw fail('E_NO_ORDER_TRAILER', `push refused: ${trailers.length} commit(s) in ${range} change code outside an order`, trailers);
  if (late.length) throw fail('E_COMMIT_AFTER_FINISH', `push refused: ${late.length} commit(s) in ${range} were made after the run of their order was finished, with no run open`, late);
  return { owner, url: redactUrl(remoteUrl), range, commits: commits.length };
}

// ORD-0043 part 12: the path the hook uses to find the plugin carries no version number. A copy of the plugin inside
// the repository, or a checkout with no version in its path, is named as before. An installed copy lives under
// <configuration>/plugins/cache/<marketplace>/analucia/<x.y.z>/: the hook then finds the newest installed plugin at
// each push, as the launchers do (the same runner), so an update of the plugin never leaves an old guard behind.
const VERSION_IN_PATH_RE = /[\\/]\d+\.\d+\.\d+(?=[\\/])/;
function hookText(top, aosPath) {
  const head = [
    '#!/bin/sh',
    '# Installed by "aos install-git-hooks" (SPEC-0002 §4, Q-90): refuse a push under the wrong GitHub account.',
    '# Arguments from git: $1 = remote name, $2 = remote URL.',
  ];
  const relAos = toPosix(relative(top, aosPath));
  const inside = !(relAos.startsWith('..') || isAbsolute(relAos));
  if (inside || !VERSION_IN_PATH_RE.test(aosPath)) {
    const target = inside ? `"$(git rev-parse --show-toplevel)/${relAos}"` : `"${toPosix(aosPath)}"`;
    return [...head, `exec node ${target} check-push "$1" "$2"`, ''].join('\n');
  }
  return [
    ...head,
    '# It finds the newest installed plugin at each push (no version number in this file).',
    `node -e "${RUNNER}" "$(git rev-parse --show-toplevel)" check-push "$1" "$2"`,
    'code=$?',
    `[ "$code" = "${NOT_FOUND_EXIT}" ] && echo "Analucia: push refused: the Analucia plugin was not found on this computer, so the push guard cannot run. Install the plugin, then push again." >&2`,
    'exit $code',
    '',
  ].join('\n');
}

// The built-in preflight check "push guard installed" (ORD-0043 part 12). Null when the project is not a git
// repository or has no remote the guard judges (an HTTPS GitHub remote of a project that names its account: the
// remotes of the check "push account"). Else { passed, detail }: the pre-push hook exists where git
// looks for it (core.hooksPath honoured), it calls `aos check-push`, and no line of it carries a version number.
export function pushGuardStatus(root) {
  const top = git(root, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0 || !top.stdout.trim()) return null;
  if (!pushAccountRemotes(root).length) return null;
  const fix = `fix it with: ${aosCommand()} install-git-hooks`;
  const where = git(root, ['rev-parse', '--git-path', 'hooks/pre-push']).stdout.trim();
  const file = isAbsolute(where) ? where : resolve(root, where);
  const shown = toPosix(relative(resolve(root), file)) || toPosix(file);
  if (!existsSync(file)) return { passed: false, detail: `there is no pre-push hook where git looks for it (${shown}), so a push is not checked by the guard; ${fix}` };
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (!lines.some((l) => /\bcheck-push\b/.test(l))) return { passed: false, detail: `the pre-push hook ${shown} does not call "aos check-push", so a push is not checked by the guard; ${fix}` };
  if (lines.some((l) => VERSION_IN_PATH_RE.test(l))) return { passed: false, detail: `the pre-push hook ${shown} finds the plugin by a path that carries a version number, so it keeps running an old guard after an update; ${fix}` };
  return { passed: true, detail: `the pre-push hook ${shown} calls "aos check-push" and names no plugin version` };
}

export function installGitHooks(root, aosPath, { dryRun = false } = {}) {
  const top = git(root, ['rev-parse', '--show-toplevel']).stdout.trim();
  if (!top) throw new RuleError('E_FILE_MISSING', `${root} is not inside a git repository`);
  const hook = hookText(top, aosPath);
  const dir = join(top, '.githooks');
  const file = join(dir, 'pre-push');
  const existed = existsSync(file);
  const hookChanged = !existed || readFileSync(file, 'utf8') !== hook;
  const pathChanged = git(top, ['config', '--local', '--get', 'core.hooksPath']).stdout.trim() !== '.githooks';
  if (!dryRun) {
    mkdirSync(dir, { recursive: true });
    if (hookChanged) writeFileSync(file, hook, { mode: 0o755 });
    const r = git(top, ['config', '--local', 'core.hooksPath', '.githooks']);
    if (r.status !== 0) throw new RuleError('E_FILE_MISSING', `git config core.hooksPath failed: ${r.stderr.trim()}`);
  }
  // ORD-0042 part 5: the account of each remote, in this repository's own configuration, so that the provider's
  // "choose an account" window has nothing to ask.
  const accounts = fixPushAccounts(root, { dryRun });
  return { file: toPosix(relative(top, file)), changed: hookChanged || pathChanged || accounts.length > 0, created: !existed, accounts: accounts.map((a) => a.remote) };
}
