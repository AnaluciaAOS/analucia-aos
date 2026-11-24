// ORD-0047 part 12 (OBS-189): the director tries each check of a draft before placing it. A signature once failed on a
// check the director had written wrong. `aos drafts --try <draft>` takes every check of the draft's verify file (the
// `preflight` ones and the `checks`) and says, for each:
//   (a) its command parses (`bash -n`);
//   (b) its patterns compile (the patterns of its `grep` calls, and the `report_lines` patterns of the file);
//   (c) when it needs neither the order's commit nor its report nor its pushed branch, it is run on the real tree.
// Each check ends in one status: pass, fail, cannot run yet (it needs the order's commit, report or branch), or
// "own problem" (it does not parse, or a pattern does not compile): the director fixes those, they cannot pass for a
// reason of their own text. A check that fails on the tree now is shown, not condemned: most checks of an order
// fail until the work is done; a failing `preflight` check is a problem, because it must pass on the untouched tree.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ID_PLACEHOLDER, isTopicDraft, listDrafts, nextOrderId } from './drafts.mjs';
import { findBash } from './lifecycle.mjs';

const NEEDS_ORDER = [
  [/\{order_commit\}/, "the order's commit"],
  [/(^|[\s/"'])report\.md\b|\.analucia\/evidence\//, "the order's report or evidence"],
  [/refs\/remotes\/origin\/|origin\/ord-/, "the order's pushed branch"],
  [/\b(?:run finish|report check|smoke check|tests compare|trailer check)\b/, "the order's own run"],
];

// The patterns of the grep calls of a command: [{ flags, pattern }]. A quoted pattern only (single or double quotes).
export function grepPatterns(run) {
  const out = [];
  const re = /\bgrep\b((?:\s+-[A-Za-z]+)*)\s+(?:(?:-e\s+)?)(?:'([^']*)'|"([^"]*)")/g;
  for (const m of run.matchAll(re)) out.push({ flags: m[1].replace(/\s+/g, ''), pattern: m[2] ?? m[3] ?? '' });
  return out;
}

const sh = (bash, args, opts = {}) => spawnSync(bash, args, { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, ...opts });

// The draft the director names: its ID, its topic, or `draft-<topic>`.
export function findDraft(root, key) {
  const k = String(key);
  return listDrafts(root).find((d) => d.id === k || d.topic === k || d.id === `draft-${k}`) ?? null;
}

// { draft, id, results: [{ section, name, status, why }], problems: [sentence], ok }. `run: false` skips (c).
export function tryDraft(root, key, { run = true, timeout = 60000 } = {}) {
  const draft = findDraft(root, key);
  if (!draft) return { draft: null, results: [], problems: [`E_FILE_MISSING no draft "${key}" in .analucia/drafts: name it by its topic or its ID`], ok: false };
  const id = isTopicDraft(draft.id) ? nextOrderId(root) : draft.id;
  const sub = (s) => String(s).split(ID_PLACEHOLDER).join(id);
  const results = [];
  const problems = [];
  if (!draft.verify) return { draft, id, results, problems: [`E_FILE_MISSING the draft has no verify file`], ok: false };
  let file;
  try { file = JSON.parse(sub(readFileSync(join(root, draft.verify), 'utf8'))); } catch (x) { return { draft, id, results, problems: [`E_JSON the verify file is not JSON: ${x.message}`], ok: false }; }
  const bash = findBash();
  const rows = [...(file.preflight ?? []).map((c) => ({ ...c, section: 'preflight' })), ...(file.checks ?? []).map((c) => ({ ...c, section: 'check' }))];
  for (const c of rows) {
    const name = String(c?.name ?? '?');
    const cmd = String(c?.run ?? '');
    const add = (status, why) => { results.push({ section: c.section, name, status, why }); if (status === 'own') problems.push(`${c.section} "${name}": ${why}`); };
    // (a) it parses
    const parse = sh(bash, ['-n', '-c', cmd]);
    if (parse.status !== 0) { add('own', `the command does not parse (bash -n): ${(parse.stderr || '').trim().split('\n').at(-1)}`); continue; }
    // (b) its patterns compile
    let bad = null;
    for (const { flags, pattern } of grepPatterns(cmd)) {
      const mode = flags.includes('P') ? '-P' : flags.includes('F') ? '-F' : flags.includes('E') ? '-E' : '-G';
      const r = sh(bash, ['-c', `grep ${mode} -e "$AOS_PATTERN" /dev/null`], { env: { ...process.env, AOS_PATTERN: pattern } });
      if (r.status === 2) { bad = `the pattern ${JSON.stringify(pattern)} does not compile (${mode}): ${(r.stderr || '').trim().split('\n').at(-1)}`; break; }
    }
    if (bad) { add('own', bad); continue; }
    // (c) one that needs the order itself cannot run yet; the others are run on the real tree
    const needs = NEEDS_ORDER.find(([re]) => re.test(cmd));
    if (needs) { add('cannot', `needs ${needs[1]}, which does not exist yet`); continue; }
    if (!run) { add('cannot', 'not run (--no-run)'); continue; }
    const r = sh(bash, ['-c', cmd], { cwd: root, timeout, maxBuffer: 16 * 1024 * 1024 });
    const expect = Number.isInteger(c.expect_exit) ? c.expect_exit : 0;
    if (r.error?.code === 'ETIMEDOUT') add('fail', `did not end in ${Math.round(timeout / 1000)} seconds`);
    else if (r.status === expect) add('pass', `exit ${r.status}`);
    else {
      const last = `${r.stderr || ''}${r.stdout || ''}`.trim().split('\n').at(-1) ?? '';
      add('fail', `exit ${r.status}, expected ${expect}${last ? ` (${last.slice(0, 120)})` : ''}`);
      if (c.section === 'preflight') problems.push(`preflight "${name}" fails on the real tree (a preflight check must pass on the untouched tree): exit ${r.status}, expected ${expect}`);
    }
  }
  // the report_lines patterns are JavaScript regular expressions
  for (const l of Array.isArray(file.report_lines) ? file.report_lines : []) {
    try { new RegExp(l.pattern); results.push({ section: 'report_lines', name: String(l.name), status: 'pass', why: 'the pattern compiles' }); } catch (x) {
      results.push({ section: 'report_lines', name: String(l.name), status: 'own', why: `the pattern does not compile: ${x.message}` });
      problems.push(`report_lines "${l.name}": the pattern does not compile: ${x.message}`);
    }
  }
  return { draft, id, results, problems, ok: problems.length === 0 };
}

const LABEL = { pass: 'pass', fail: 'fail on the real tree now', cannot: 'cannot run yet', own: 'FIX: its own text' };
export function tryLines(r) {
  if (!r.draft) return r.problems;
  const lines = [`${r.draft.id}${r.draft.topic ? ` (would be ${r.id}, not yet given)` : ''}: ${r.results.length} check(s) tried`];
  for (const x of r.results) lines.push(`  [${LABEL[x.status]}] ${x.section} "${x.name}" — ${x.why}`);
  const n = (s) => r.results.filter((x) => x.status === s).length;
  lines.push(`  ${n('pass')} pass · ${n('fail')} fail on the real tree now · ${n('cannot')} cannot run yet · ${n('own')} to fix in their own text`);
  for (const p of r.problems) lines.push(`  fix: ${p}`);
  return lines;
}
