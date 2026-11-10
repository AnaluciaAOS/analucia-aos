// Guards (SPEC-0002 §4): resume at start, no silent ending, off switch, protected paths, one director, right account.
// Every refusal says what clears it and who must do it (Q-86).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { PLUGIN_DIR, accountFixes, aosCommand, githubSlug } from './cli.mjs';
import { fileURLToPath } from 'node:url';
import { derive } from './derive.mjs';
import { appendEvent, logPath, readLog, timestampFor, verifyChain } from './log.mjs';
import { tokenPatterns } from './secret-patterns.mjs';
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
    appendEvent(root, { type: 'role.declared', actor: 'executor', subject: null, agent, payload: { role: 'executor', source: typeof input.source === 'string' ? input.source : 'startup' } });
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
  for (const e of events) {
    if (!e.subject) continue;
    if (e.type === 'run.started') open.set(e.subject, e);
    if (e.type === 'run.finished') open.delete(e.subject);
  }
  return [...open.entries()].map(([id, e]) => ({ id, run: e.payload?.run ?? null }));
}

// Returns null when it is safe to stop, else the message that explains how to clear the block.
export function checkWriteback(root) {
  if (!existsSync(logPath(root))) return null;
  const broken = verifyChain(readFileSync(logPath(root)));
  if (broken) {
    return `Analucia: the event log is broken at .analucia/events.jsonl line ${broken.line} (${broken.code}: ${broken.message}). `
      + 'Do not edit the log. The director restores it from git and confirms with "aos verify-log" before anyone continues.';
  }
  const runs = openRuns(readLog(root).events);
  if (!runs.length) return null;
  return runs.map(({ id, run }) => `Analucia: run ${run ?? '?'} of ${id} is still open. Before ending, the executor records its outcome: `
    + `aos run finish ${id} --outcome <done|blocked|needs_decision|budget_exhausted|failed> --evidence .analucia/evidence/${id}/report.md`).join('\n');
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

export function halt(root, { reason, isTTY, now = new Date() }) {
  needsOwnerTTY(isTTY, 'halt');
  if (!reason || !reason.trim()) throw new RuleError('E_MISSING_FIELD', 'usage: aos halt --reason "<text>"');
  if (existsSync(haltPath(root))) throw new RuleError('E_TRANSITION', `already ${haltText(root)}`);
  // The switch must work even if the log cannot be written: create HALT first, then log.
  writeFileSync(haltPath(root), `${JSON.stringify({ reason, since: timestampFor(root, now), by: 'owner' })}\n`);
  appendEvent(root, { type: 'operation.logged', actor: 'owner', subject: null, payload: { operation: 'halt', reason } }, { now });
}

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

// Returns null to allow, or the message to block with.
export function preToolUse(root, input = {}) {
  const tool = input.tool_name ?? '';
  const ti = input.tool_input ?? {};
  if (existsSync(haltPath(root)) && !READ_TOOLS.includes(tool)) {
    return `Analucia is ${haltText(root)}. Only reads (${READ_TOOLS.join(', ')}) are allowed; "${tool}" is blocked. `
      + 'Stop and wait: the owner lifts the halt by running "aos resume" in their own terminal. Agents cannot.';
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
    const director = lines.filter((l) => l.trim() !== '@AGENTS.md' && (/\bdirector\b/i.test(l) || l.includes(BEGIN) || l.includes(END)));
    if (director.length) problems.push(`CLAUDE.md contains director instructions (${director.length} line(s), e.g. ${JSON.stringify(director[0].trim().slice(0, 60))}); the executor entrypoint holds only "@AGENTS.md". Move them to the director's own entrypoint`);
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

function commitChecks(root, commits) {
  const started = new Set();
  const logFile = join(root, '.analucia', 'events.jsonl');
  if (existsSync(logFile)) {
    for (const l of readFileSync(logFile, 'utf8').split('\n')) {
      try {
        const e = JSON.parse(l);
        if (e.type === 'run.started') started.add(e.subject);
      } catch { /* blank line */ }
    }
  }
  const patterns = secretPatterns();
  const trailers = [];
  const secrets = [];
  for (const sha of commits) {
    const short = sha.slice(0, 7);
    const paths = git(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', '-m', '--first-parent', sha]).stdout.split('\n').filter(Boolean);
    const outside = paths.filter((p) => !isOwnerDirectorPath(p));
    if (outside.length) {
      const ids = orderTrailers(git(root, ['log', '-1', '--format=%B', sha]).stdout);
      const valid = ids.filter((id) => started.has(id));
      if (!ids.length) trailers.push(`${short} changes ${outside[0]}${outside.length > 1 ? ` (+${outside.length - 1} more)` : ''} but has no "Analucia-Order: ORD-NNNN" trailer`);
      else if (!valid.length) trailers.push(`${short} names ${ids.join(', ')} in its trailer, but no such order has a run.started in the log`);
    }
    for (const a of addedLines(root, sha)) {
      for (const p of patterns) if (p.re.test(a.text)) secrets.push(`${short} ${a.file}:${a.line} matches ${p.name}`);
    }
  }
  return { trailers, secrets };
}

const fail = (code, message, problems) => Object.assign(new RuleError(code, message), { problems });

export function checkPush(root, { remote = 'origin', url } = {}) {
  const pj = join(root, '.analucia', 'project.json');
  const owner = existsSync(pj) ? JSON.parse(readFileSync(pj, 'utf8')).github_owner : undefined;
  if (!owner) throw new RuleError('E_ACCOUNT', `push refused: .analucia/project.json has no "github_owner". The owner sets it by answering the GitHub account question of: ${aosCommand()} init`);
  const remoteUrl = url ?? git(root, ['remote', 'get-url', remote]).stdout.trim();
  // SPEC-0004 §5: a credential in the remote URL is refused, and never printed.
  if (remoteUrl && urlHasSecret(remoteUrl)) {
    const slug = githubSlug(remoteUrl) ?? { owner, repo: basename(resolve(root)) };
    throw new RuleError('E_SECRET_IN_URL', `push refused: the URL of remote "${remote}" carries a credential (${redactUrl(remoteUrl)}). The owner removes it: git remote set-url ${remote} https://${owner}@github.com/${slug.owner}/${slug.repo}.git, then rotates that credential`);
  }
  const user = remoteUrl ? urlUser(remoteUrl) : null;
  const cred = git(root, ['config', '--get', 'credential.https://github.com.username']).stdout.trim() || null;
  const same = (v) => typeof v === 'string' && v.toLowerCase() === owner.toLowerCase();
  if (!(same(user) && same(cred))) {
    const fixes = accountFixes({ owner, user, cred, url: remoteUrl, remote, folder: basename(resolve(root)) });
    throw new RuleError('E_ACCOUNT', `push refused: remote "${remote}" URL user is ${JSON.stringify(user)}, credential.https://github.com.username is ${JSON.stringify(cred)}, `
      + `project github_owner is "${owner}". The owner runs, in this repo: ${fixes.join(' ; then: ')}; then push again`);
  }
  // SPEC-0004 §4–§5: every commit being pushed.
  const { range, commits } = pushedCommits(root, remote);
  const { trailers, secrets } = commitChecks(root, commits);
  if (secrets.length) throw fail('E_SECRET', `push refused: ${secrets.length} added line(s) in ${range} match a secret pattern (values not shown)`, secrets);
  if (trailers.length) throw fail('E_NO_ORDER_TRAILER', `push refused: ${trailers.length} commit(s) in ${range} change code outside an order`, trailers);
  return { owner, url: redactUrl(remoteUrl), range, commits: commits.length };
}

export function installGitHooks(root, aosPath, { dryRun = false } = {}) {
  const top = git(root, ['rev-parse', '--show-toplevel']).stdout.trim();
  if (!top) throw new RuleError('E_FILE_MISSING', `${root} is not inside a git repository`);
  const relAos = toPosix(relative(top, aosPath));
  const target = relAos.startsWith('..') || isAbsolute(relAos) ? `"${toPosix(aosPath)}"` : `"$(git rev-parse --show-toplevel)/${relAos}"`;
  const hook = [
    '#!/bin/sh',
    '# Installed by "aos install-git-hooks" (SPEC-0002 §4, Q-90): refuse a push under the wrong GitHub account.',
    '# Arguments from git: $1 = remote name, $2 = remote URL.',
    `exec node ${target} check-push "$1" "$2"`,
    '',
  ].join('\n');
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
  return { file: toPosix(relative(top, file)), changed: hookChanged || pathChanged, created: !existed };
}
