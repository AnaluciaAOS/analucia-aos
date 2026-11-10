// Adoption audit (SPEC-0006): reads a project that is already under way, before the first order.
// Read only: it writes nothing except its report (.analucia/views/adoption.md) and one adoption.audited event.
// Never prints a secret: a finding names the kind, the file, the commit and the line — never the value.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { appendEvent, readLog, timestampFor } from './log.mjs';
import { personLocale } from './locale.mjs';
import { LOCALES, catalog } from './onboarding.mjs';
import { RuleError } from './state.mjs';
import { isEnvLike, secretKindsIn, tokenPatterns } from './secret-patterns.mjs';

const NO_PROMPT = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
const git = (root, args, opts = {}) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env: NO_PROMPT, maxBuffer: 512 * 1024 * 1024, ...opts });
const toPosix = (p) => p.split(sep).join('/');
export const SEVERITIES = ['high', 'medium', 'low', 'info'];
const MB = 1024 * 1024;

const ARCHIVE_EXT = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'bak', 'sql', 'dump', 'dmp', 'iso', 'jar', 'war']);
const CODE_DIRS = /(^|\/)(src|lib|app|server|client|components|pages|api)\//;
const NON_CODE_IN_CODE = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bak', 'sql', 'dump', 'log', 'xlsx', 'xls', 'docx', 'doc', 'pdf', 'psd', 'mp4', 'mov', 'csv']);
const SOURCE_EXT = new Set(['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'cs', 'php', 'swift', 'c', 'cc', 'cpp', 'h', 'vue', 'svelte', 'sql']);
const isBinary = (buf) => buf.subarray(0, 8000).includes(0);

function readText(root, rel) {
  try {
    const buf = readFileSync(join(root, rel));
    if (buf.length > 4 * MB || isBinary(buf)) return null;
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

function walk(root, dir = root, out = []) {
  for (const f of readdirSync(dir)) {
    if (f === '.git' || f === 'node_modules') continue;
    const p = join(dir, f);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(root, p, out);
    else out.push(toPosix(relative(root, p)));
  }
  return out;
}

// ---------- the checks (SPEC-0006 §4) ----------

function secretsInTree(root, tracked, tokens) {
  const out = [];
  for (const f of tracked) {
    const text = readText(root, f);
    if (text === null) continue;
    text.split(/\r?\n/).forEach((line, i) => {
      for (const kind of secretKindsIn(f, line, tokens)) out.push({ check: 'AD-SECRET-TREE', severity: 'high', kind, file: f, line: i + 1, detail: { key: 'adopt.f.secret_tree', vars: { kind } }, next: { who: 'owner', key: 'adopt.n.secret' } });
    });
  }
  return out;
}

// Every added line in the whole history (all refs, deleted files included); the first commit that introduced
// each (kind, file) is reported.
function secretsInHistory(root, tokens, notVerified) {
  const r = git(root, ['log', '--all', '--reverse', '--format=%x00%H', '-p', '--unified=0', '--no-color', '--no-ext-diff', '--no-renames']);
  if (r.status !== 0) {
    notVerified.push({ check: 'AD-SECRET-HISTORY', key: 'adopt.nv.history' });
    return [];
  }
  const seen = new Map();
  let commit = null;
  let file = null;
  let line = 0;
  for (const l of r.stdout.split('\n')) {
    if (l.startsWith('\x00')) { commit = l.slice(1, 8); file = null; continue; }
    if (l.startsWith('+++ ')) { file = l === '+++ /dev/null' ? null : l.replace(/^\+\+\+ b\//, ''); continue; }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) { line = Number(h[1]); continue; }
    if (file && l.startsWith('+')) {
      for (const kind of secretKindsIn(file, l.slice(1), tokens)) {
        const key = `${kind}\x00${file}`;
        if (!seen.has(key)) seen.set(key, { check: 'AD-SECRET-HISTORY', severity: 'high', kind, file, line, commit, detail: { key: 'adopt.f.secret_history', vars: { kind, commit } }, next: { who: 'owner', key: 'adopt.n.secret_history' } });
      }
      line++;
    }
  }
  return [...seen.values()];
}

function envFiles(root, tracked, files) {
  const out = [];
  for (const f of tracked.filter(isEnvLike)) out.push({ check: 'AD-ENV', severity: 'high', kind: 'env_tracked', file: f, detail: { key: 'adopt.f.env_tracked' }, next: { who: 'owner', key: 'adopt.n.env' } });
  const trackedSet = new Set(tracked);
  for (const f of files.filter((x) => isEnvLike(x) && !trackedSet.has(x))) {
    if (git(root, ['check-ignore', '-q', f]).status !== 0) out.push({ check: 'AD-ENV', severity: 'high', kind: 'env_unignored', file: f, detail: { key: 'adopt.f.env_unignored' }, next: { who: 'owner', key: 'adopt.n.env' } });
  }
  return out;
}

function hygiene(root, tracked) {
  const out = [];
  const migrations = new Map();
  for (const f of tracked) {
    const ext = extname(f).slice(1).toLowerCase();
    let size = 0;
    try { size = statSync(join(root, f)).size; } catch { continue; }
    if (size > 5 * MB) {
      let binary = ARCHIVE_EXT.has(ext);
      if (!binary) {
        try { binary = isBinary(readFileSync(join(root, f))); } catch { /* unreadable */ }
      }
      if (binary) out.push({ check: 'AD-HYGIENE', severity: 'medium', kind: 'large_file', file: f, detail: { key: 'adopt.f.large_file', vars: { size: Math.round(size / MB), ext: ext || 'bin' } }, next: { who: 'director', key: 'adopt.n.hygiene' } });
    }
    if (CODE_DIRS.test(f) && NON_CODE_IN_CODE.has(ext) && size <= 5 * MB) {
      out.push({ check: 'AD-HYGIENE', severity: 'medium', kind: 'noncode_in_code', file: f, detail: { key: 'adopt.f.noncode', vars: { ext } }, next: { who: 'director', key: 'adopt.n.hygiene' } });
    }
    const m = /(^|\/)migrations\/(\d{3,14})[_-][^/]+$/.exec(f);
    if (m) {
      const k = `${f.slice(0, f.lastIndexOf('/'))}\x00${m[2]}`;
      migrations.set(k, [...(migrations.get(k) ?? []), f]);
    }
  }
  for (const [k, list] of migrations) {
    if (list.length > 1) out.push({ check: 'AD-HYGIENE', severity: 'medium', kind: 'migration_duplicate', file: list.sort()[0], detail: { key: 'adopt.f.migration_dup', vars: { prefix: k.split('\x00')[1] } }, next: { who: 'director', key: 'adopt.n.hygiene' } });
  }
  return out;
}

// README*.md anywhere and docs/** at the top: backticked paths that do not exist, and npm scripts that do not.
function docs(root, tracked, files, notVerified) {
  const basenames = new Set(files.map((f) => f.split('/').pop()));
  const out = [];
  const pkg = (() => { try { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')); } catch { return null; } })();
  const docFiles = tracked.filter((f) => /(^|\/)readme(\.[a-z]+)?\.md$/i.test(f) || /^docs\/.*\.md$/i.test(f));
  let mentionsPort = false;
  for (const f of docFiles) {
    const text = readText(root, f);
    if (text === null) continue;
    const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
    text.split(/\r?\n/).forEach((lineText, i) => {
      if (/\b(?:port|puerto)\s*:?\s*\d{2,5}\b|localhost:\d{2,5}/i.test(lineText)) mentionsPort = true;
      for (const m of lineText.matchAll(/`([^`\s]+)`/g)) {
        const ref = m[1].replace(/[),.;:]+$/, '');
        if (!/^[\w.\-/]+$/.test(ref) || /^(?:https?|git)[:/]/i.test(ref) || ref.startsWith('-') || ref.startsWith('/') || ref.includes('..')) continue;
        if (!(ref.includes('/') || /\.[a-z0-9]{1,5}$/i.test(ref)) || /NNNN|ORD-\d{4}\b|<|\*|\$/.test(ref) || /^\d/.test(ref)) continue;
        if (isEnvLike(ref)) continue; // .env names are patterns in docs, not files
        // A bare file name (no folder) exists if any file in the tree has that name.
        const exists = existsSync(join(root, ref)) || (dir && existsSync(join(root, dir, ref))) || (!ref.includes('/') && basenames.has(ref));
        if (!exists) out.push({ check: 'AD-DOCS', severity: 'medium', kind: 'missing_reference', file: f, line: i + 1, detail: { key: 'adopt.f.docs_missing', vars: { ref } }, next: { who: 'director', key: 'adopt.n.docs' } });
      }
      for (const m of lineText.matchAll(/\bnpm run ([\w:-]+)/g)) {
        if (pkg && !(pkg.scripts && m[1] in pkg.scripts)) out.push({ check: 'AD-DOCS', severity: 'medium', kind: 'missing_script', file: f, line: i + 1, detail: { key: 'adopt.f.docs_script', vars: { ref: m[1] } }, next: { who: 'director', key: 'adopt.n.docs' } });
      }
    });
  }
  if (mentionsPort) notVerified.push({ check: 'AD-DOCS', key: 'adopt.nv.ports' });
  return out;
}

function backup(root, tracked, files, now, notVerified) {
  const scripts = tracked.filter((f) => /(backup|respaldo|deploy|despliegue)/i.test(f.split('/').pop()) && /\.(sh|ps1|bat|cmd|js|mjs|cjs|py|ts|ya?ml)$/i.test(f));
  let pkgScripts = [];
  try { pkgScripts = Object.keys(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts ?? {}).filter((s) => /backup|deploy/i.test(s)); } catch { /* no package.json */ }
  if (!scripts.length && !pkgScripts.length) {
    notVerified.push({ check: 'AD-BACKUP', key: 'adopt.nv.backup' });
    return [{ check: 'AD-BACKUP', severity: 'medium', kind: 'no_backup_script', file: '.', detail: { key: 'adopt.f.backup_none' }, next: { who: 'director', key: 'adopt.n.backup' } }];
  }
  // Output visible from the repo: files under a backup(s)/ folder in the working tree.
  const outputs = files.filter((f) => /(^|\/)(backups?|respaldos?)\//i.test(f));
  if (!outputs.length) {
    notVerified.push({ check: 'AD-BACKUP', key: 'adopt.nv.backup' });
    return [];
  }
  const newest = Math.max(...outputs.map((f) => { try { return statSync(join(root, f)).mtimeMs; } catch { return 0; } }));
  const hours = Math.floor((now.getTime() - newest) / 3600000);
  if (hours > 48) return [{ check: 'AD-BACKUP', severity: 'high', kind: 'backup_stale', file: outputs.sort()[0].split('/').slice(0, -1).join('/') || '.', detail: { key: 'adopt.f.backup_stale', vars: { hours } }, next: { who: 'owner', key: 'adopt.n.backup_stale' } }];
  return [];
}

function spof(root, files, trackedSet) {
  const out = [];
  const remotes = git(root, ['remote']).stdout.split('\n').filter(Boolean);
  if (!remotes.length) out.push({ check: 'AD-SPOF', severity: 'high', kind: 'no_remote', file: '.', detail: { key: 'adopt.f.spof_no_remote' }, next: { who: 'owner', key: 'adopt.n.spof' } });
  else {
    const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
    const ahead = Number(git(root, ['rev-list', '--count', 'HEAD', '--not', '--remotes']).stdout.trim() || 0);
    if (ahead > 0) out.push({ check: 'AD-SPOF', severity: 'high', kind: 'unpushed_commits', file: '.', detail: { key: 'adopt.f.spof_unpushed', vars: { n: ahead, branch } }, next: { who: 'owner', key: 'adopt.n.spof' } });
  }
  for (const f of files) {
    if (trackedSet.has(f) || !SOURCE_EXT.has(extname(f).slice(1).toLowerCase())) continue;
    let size = 0;
    try { size = statSync(join(root, f)).size; } catch { continue; }
    if (size > 50 * 1024 && git(root, ['check-ignore', '-q', f]).status !== 0) {
      out.push({ check: 'AD-SPOF', severity: 'high', kind: 'large_untracked_source', file: f, detail: { key: 'adopt.f.spof_untracked', vars: { kb: Math.round(size / 1024) } }, next: { who: 'owner', key: 'adopt.n.spof' } });
    }
  }
  return out;
}

function tests(root, tracked, notVerified) {
  let where = null;
  try {
    const s = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts?.test;
    if (s && !/no test specified/i.test(s)) where = 'npm test';
  } catch { /* no package.json */ }
  if (!where) {
    const t = tracked.find((f) => /(^|\/)(tests?|__tests__|spec)\/.*\.(m?[jt]sx?|py|rb|go)$/.test(f) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(f) || /(^|\/)test_[^/]+\.py$/.test(f));
    if (t) where = t.split('/').slice(0, -1).join('/') || t;
  }
  if (!where) return { found: false, findings: [{ check: 'AD-TESTS', severity: 'medium', kind: 'no_tests', file: '.', detail: { key: 'adopt.f.tests_none' }, next: { who: 'director', key: 'adopt.n.tests' } }] };
  notVerified.push({ check: 'AD-TESTS', key: 'adopt.nv.tests', vars: { where } });
  return { found: true, findings: [] };
}

function deps(root) {
  const out = [];
  let pkg = null;
  try { pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')); } catch { return out; }
  const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  if (Object.keys(all).length && !['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json', 'bun.lockb'].some((f) => existsSync(join(root, f)))) {
    out.push({ check: 'AD-DEPS', severity: 'low', kind: 'no_lockfile', file: 'package.json', detail: { key: 'adopt.f.deps_lock' }, next: { who: 'director', key: 'adopt.n.deps' } });
  }
  for (const [name, spec] of Object.entries(all).sort()) {
    if (spec === '' || spec === '*' || spec === 'latest' || spec === 'x') out.push({ check: 'AD-DEPS', severity: 'low', kind: 'unpinned', file: 'package.json', detail: { key: 'adopt.f.deps_unpinned', vars: { pkg: name } }, next: { who: 'director', key: 'adopt.n.deps' } });
  }
  return out;
}

// ---------- the audit ----------

const ORDER = (f) => [SEVERITIES.indexOf(f.severity), f.check, f.file, f.line ?? 0, f.kind];
const cmp = (a, b) => {
  const x = ORDER(a);
  const y = ORDER(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
};

export function runAudit(root, { now = new Date() } = {}) {
  if (git(root, ['rev-parse', '--is-inside-work-tree']).stdout.trim() !== 'true') {
    throw new RuleError('E_ADOPT_UNAVAILABLE', `${root} is not a git work tree: the audit reads the repository and its history`);
  }
  const tracked = git(root, ['ls-files', '-z']).stdout.split('\0').filter(Boolean);
  const files = walk(root);
  const trackedSet = new Set(tracked);
  const tokens = tokenPatterns();
  const notVerified = [];
  const t = tests(root, tracked, notVerified);
  const findings = [
    ...secretsInTree(root, tracked, tokens),
    ...secretsInHistory(root, tokens, notVerified),
    ...envFiles(root, tracked, files),
    ...hygiene(root, tracked),
    ...docs(root, tracked, files, notVerified),
    ...backup(root, tracked, files, now, notVerified),
    ...spof(root, files, trackedSet),
    ...t.findings,
    ...deps(root),
  ].sort(cmp).map((f, i) => ({ id: `AD-${String(i + 1).padStart(3, '0')}`, ...f }));
  notVerified.push({ check: 'AD-BRANCH', key: 'adopt.nv.branch' });

  const languages = {};
  for (const f of tracked) {
    const ext = extname(f).slice(1).toLowerCase();
    if (ext) languages[ext] = (languages[ext] ?? 0) + 1;
  }
  const lastCommit = Number(git(root, ['log', '-1', '--format=%ct']).stdout.trim() || 0);
  const baseline = {
    commits: Number(git(root, ['rev-list', '--count', '--all']).stdout.trim() || 0),
    tracked_files: tracked.length,
    tests_found: t.found ? 1 : 0,
    last_commit_unix: lastCommit,
    languages: Object.fromEntries(Object.entries(languages).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 12)),
  };
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s).length]));
  return { baseline, findings, notVerified, counts, proposals: proposals(findings) };
}

// SPEC-0006 §3: aos init audits a project that is already under way.
export const AUDIT_THRESHOLDS = { commits: 20, tracked_files: 50 };
export function needsAudit(root) {
  if (git(root, ['rev-parse', '--is-inside-work-tree']).stdout.trim() !== 'true') return false;
  const commits = Number(git(root, ['rev-list', '--count', '--all']).stdout.trim() || 0);
  const tracked = git(root, ['ls-files', '-z']).stdout.split('\0').filter(Boolean).length;
  return commits > AUDIT_THRESHOLDS.commits || tracked > AUDIT_THRESHOLDS.tracked_files;
}

// SPEC-0006 §5: one rotation order (risk high, owner only) per high secret finding; then one history-cleaning
// order; fix orders (low or medium) for the rest. Text only: the audit never creates order files.
export function proposals(findings) {
  const out = [];
  const secrets = findings.filter((f) => f.check === 'AD-SECRET-TREE' || f.check === 'AD-SECRET-HISTORY');
  for (const f of secrets) out.push({ kind: 'rotate', risk: 'high', who: 'owner', finding: f.id, vars: { kind: f.kind, file: f.file, where: f.commit ? `commit ${f.commit}, line ${f.line}` : `line ${f.line}` } });
  if (secrets.some((f) => f.check === 'AD-SECRET-HISTORY')) out.push({ kind: 'clean_history', risk: 'high', who: 'owner', finding: secrets.filter((f) => f.check === 'AD-SECRET-HISTORY').map((f) => f.id).join(',') });
  for (const f of findings.filter((x) => !secrets.includes(x))) {
    out.push({ kind: 'fix', risk: f.severity === 'high' || f.check === 'AD-BACKUP' || f.check === 'AD-TESTS' ? 'medium' : 'low', who: 'director', finding: f.id, vars: { check: f.check, file: f.file } , detail: f.detail });
  }
  return out;
}

export function reportText(audit, locale = 'en', ts = '') {
  const t = catalog(LOCALES.includes(locale) ? locale : 'en');
  const b = audit.baseline;
  const out = [`# ${t('adopt.title')} — ${ts}`, '', t('adopt.read_only'), '', `## ${t('adopt.baseline')}`, ''];
  out.push(`- ${t('adopt.base.commits', { n: b.commits })}`, `- ${t('adopt.base.files', { n: b.tracked_files })}`);
  out.push(`- ${t('adopt.base.languages', { list: Object.entries(b.languages).map(([k, v]) => `${k} ${v}`).join(', ') || t('adopt.none') })}`);
  out.push(`- ${t('adopt.base.tests', { value: t(b.tests_found ? 'adopt.yes' : 'adopt.no') })}`);
  out.push(`- ${t('adopt.base.last_commit', { date: b.last_commit_unix ? new Date(b.last_commit_unix * 1000).toISOString().slice(0, 10) : '—' })}`);
  out.push('', `## ${t('adopt.findings')}`, '');
  if (!audit.findings.length) out.push(`- ${t('adopt.none')}`);
  for (const f of audit.findings) {
    const where = `${f.file}${f.line ? `:${f.line}` : ''}${f.commit ? ` @${f.commit}` : ''}`;
    out.push(`- ${f.id} ${f.severity.toUpperCase()} ${f.check} ${where}: ${t(f.detail.key, f.detail.vars)}`);
    out.push(`  ${t('check.next', { who: f.next.who })}: ${t(f.next.key)}`);
  }
  out.push('', `## ${t('adopt.not_verified')}`, '');
  for (const n of audit.notVerified) out.push(`- ${n.check}: ${t(n.key, n.vars)}`);
  out.push('', `## ${t('adopt.proposals')}`, '');
  if (!audit.proposals.length) out.push(`- ${t('adopt.none')}`);
  for (const p of audit.proposals) {
    if (p.kind === 'rotate') out.push(`- [${p.finding}] ${t('adopt.p.rotate', p.vars)}`);
    else if (p.kind === 'clean_history') out.push(`- [${p.finding}] ${t('adopt.p.clean_history')}`);
    else out.push(`- [${p.finding}] ${t('adopt.p.fix', { ...p.vars, detail: t(p.detail.key, p.detail.vars), risk: p.risk })}`);
  }
  const c = audit.counts;
  out.push('', t('adopt.summary', { ...c, nv: audit.notVerified.length }));
  return out.join('\n');
}

// aos adopt: run, save the report, append one adoption.audited event (counts, finding ids, the numeric baseline:
// no values, no paths). Exit 0 without high findings, 1 with at least one.
export function adopt(root, { now = new Date(), out = () => {}, locale: forced } = {}) {
  const audit = runAudit(root, { now });
  const locale = personLocale(root, { flag: forced }); // ORD-0033 B.3: one fallback for every person-facing line
  const ts = timestampFor(root, now);
  const text = reportText(audit, locale, ts);
  mkdirSync(join(root, '.analucia', 'views'), { recursive: true });
  writeFileSync(join(root, '.analucia', 'views', 'adoption.md'), `${text}\n`);
  let logged = false;
  try {
    readLog(root);
    appendEvent(root, {
      type: 'adoption.audited', actor: 'system', subject: null,
      payload: {
        level: 'observed', counts: audit.counts, findings: audit.findings.map((f) => f.id),
        checks: Object.fromEntries([...new Set(audit.findings.map((f) => f.check))].sort().map((c) => [c, audit.findings.filter((f) => f.check === c).length])),
        not_verified: [...new Set(audit.notVerified.map((n) => n.check))], baseline: audit.baseline,
      },
    }, { now });
    logged = true;
  } catch { /* a project without a log yet: the report is still written */ }
  out(text);
  out(catalog(LOCALES.includes(locale) ? locale : 'en')('adopt.saved', { path: '.analucia/views/adoption.md' }));
  return { audit, exit: audit.counts.high > 0 ? 1 : 0, logged };
}
