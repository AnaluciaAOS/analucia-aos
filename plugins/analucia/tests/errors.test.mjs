// SPEC-0003 §1–§2: always-loaded rules index, docs index, actionable errors, aos explain.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ERRORS, renderedNext } from '../lib/errors.mjs';
import { renderCommands } from '../lib/cli.mjs';
import { BEGIN, END, blockTemplate } from '../lib/guards.mjs';
import { appendEvent, logPath } from '../lib/log.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const PLUGIN = join(here, '..');
const REPO = join(PLUGIN, '..', '..');
const AOS = join(PLUGIN, 'bin', 'aos.mjs');
const env = { ...process.env };
delete env.CLAUDE_PROJECT_DIR;
const run = (args, { cwd = REPO, input = '' } = {}) => spawnSync(process.execPath, [AOS, ...args], { cwd, encoding: 'utf8', input, env });

// A code is a whole token E_XXX; identifiers that merely contain "E_" (WRITE_RE, CLAUDE_PROJECT_DIR) are not codes.
const CODE_RE = /(?<![A-Za-z0-9_])E_[A-Z][A-Z_]*(?![A-Za-z0-9_])/g;
function sourceCodes() {
  const files = [
    ...readdirSync(join(PLUGIN, 'lib')).filter((f) => f.endsWith('.mjs') && f !== 'errors.mjs').map((f) => join(PLUGIN, 'lib', f)),
    ...readdirSync(join(PLUGIN, 'bin')).filter((f) => f.endsWith('.mjs')).map((f) => join(PLUGIN, 'bin', f)),
  ];
  return [...new Set(files.flatMap((f) => readFileSync(f, 'utf8').match(CODE_RE) ?? []))].sort();
}
const pageCodes = () => readdirSync(join(PLUGIN, 'docs', 'errors')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort();
const HEADINGS = ['## What happened', '## What to do next', '## Patterns', '## Trade-offs', '## Gotchas'];

test('the three code sets are equal: source, registry, doc pages', () => {
  const src = sourceCodes();
  const reg = Object.keys(ERRORS).sort();
  const pages = pageCodes();
  assert.ok(src.length >= 40, `only ${src.length} codes found in source`);
  assert.deepEqual(reg, src, 'registry vs source');
  assert.deepEqual(pages, src, 'pages vs source');
});

test('registry entries: one imperative sentence and a valid role', () => {
  for (const [code, e] of Object.entries(ERRORS)) {
    assert.ok(['owner', 'director', 'executor', 'system'].includes(e.who), `${code}: who ${e.who}`);
    assert.match(e.next, /^[A-Z][^.]*[^.\s].*\.$/, `${code}: next must be one sentence ending in "."`);
    assert.equal(e.next.split(/\.\s+[A-Z]/).length, 1, `${code}: next must be a single sentence`);
  }
});

test('every page has exactly the five headings, in order, and repeats the registry next step', () => {
  for (const code of pageCodes()) {
    // A CRLF checkout (core.autocrlf) is the same page.
    const text = readFileSync(join(PLUGIN, 'docs', 'errors', `${code}.md`), 'utf8').replace(/\r\n/g, '\n');
    const h2 = text.split('\n').filter((l) => l.startsWith('## '));
    assert.deepEqual(h2, HEADINGS, code);
    assert.ok(text.startsWith(`# ${code}\n`), `${code}: title`);
    const nextSection = text.slice(text.indexOf('## What to do next'), text.indexOf('## Patterns'));
    assert.ok(nextSection.includes(ERRORS[code].next), `${code}: page and registry disagree on the next step`);
    assert.ok(nextSection.includes(`(${ERRORS[code].who})`), `${code}: page must name who acts`);
  }
});

// Every first line "...: E_CODE ..." must be followed by "  next (<who>): <next> — see docs/errors/E_CODE.md",
// with <next> as printed on this machine (ORD-0029 B: "aos <command>" becomes the real command).
function assertNextLines(output, label) {
  const lines = output.split('\n');
  let seen = 0;
  lines.forEach((l, i) => {
    const m = /(?:^|: )(E_[A-Z_]+) /.exec(l);
    if (!m || l.startsWith(' ')) return;
    seen++;
    const e = ERRORS[m[1]];
    assert.ok(e, `${label}: ${m[1]} not in registry`);
    assert.equal(lines[i + 1], `  next (${e.who}): ${renderedNext(m[1])} — see docs/errors/${m[1]}.md`, `${label}: line ${i + 2}`);
  });
  assert.ok(seen > 0, `${label}: no error line in ${JSON.stringify(output)}`);
}

test('every error print carries the next line (sampled across commands)', () => {
  const root = mkdtempSync(join(tmpdir(), 'aos-err-'));
  mkdirSync(join(root, '.analucia', 'orders'), { recursive: true });
  writeFileSync(join(root, '.analucia', 'project.json'), '{"wip_limit":1}\n');
  writeFileSync(logPath(root), '');
  writeFileSync(join(root, 'AGENTS.md'), '# none\n');
  appendEvent(root, { type: 'record.created', actor: 'director', subject: 'ORD-0001' });
  appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: 'ORD-0001', payload: { from: 'draft', to: 'ready' } });
  const r = (args, input) => run([...args, '--root', root], { input });

  const samples = [
    ['validate (invalid fixture)', run(['validate', join(here, 'fixtures', 'invalid', 'E_KIND_ENUM', 'ORD-0001.md')]).stdout],
    ['event append (illegal transition)', r(['event', 'append', '--type', 'order.state_changed', '--actor', 'owner', '--subject', 'ORD-0001', '--payload', '{"from":"ready","to":"closed"}']).stdout],
    ['run start (no order file)', r(['run', 'start', 'ORD-0009']).stderr],
    ['close (no TTY)', r(['close', 'ORD-0001'], 'CLOSE\n').stderr],
    ['halt (no TTY)', r(['halt', '--reason', 'x']).stderr],
    ['verify (no lock)', r(['verify', 'ORD-0001']).stderr],
    ['check-roles', r(['check-roles']).stderr],
    ['check-push', r(['check-push', 'origin', 'https://someone@github.com/x/y.git']).stderr],
    ['explain (unknown code)', run(['explain', 'E_NOPE']).stderr],
  ];
  for (const [label, out] of samples) assertNextLines(out, label);

  // Edit line 1 (the last line has no successor, so the chain cannot see an edit there).
  writeFileSync(logPath(root), readFileSync(logPath(root), 'utf8').replace('"director"', '"Director"'));
  assertNextLines(r(['verify-log']).stdout, 'verify-log (broken chain)');
  assertNextLines(r(['derive']).stdout, 'derive (invalid log)');
});

test('the always-loaded block is at most 8192 bytes and ends with the docs pointer', () => {
  const block = `${BEGIN}\n${blockTemplate()}${END}`;
  assert.ok(Buffer.byteLength(block, 'utf8') <= 8192, `${Buffer.byteLength(block)} bytes`);
  const lastLine = blockTemplate().trimEnd().split('\n').at(-1);
  assert.match(lastLine, /plugins\/analucia\/docs\/INDEX\.md/);
  for (const topic of ['### Roles', 'No order file, no work', '### Executor loop', '### Never edit director files', '### Halt', '### Where state lives']) {
    assert.ok(blockTemplate().includes(topic), `block covers ${topic}`);
  }
  const agents = readFileSync(join(REPO, 'AGENTS.md'), 'utf8').replace(/\r\n/g, '\n');
  const m = /<!-- analucia:begin -->[\s\S]*?<!-- analucia:end -->/.exec(agents);
  assert.ok(m && m[0] === block, 'AGENTS.md carries the current block (run aos agents-md sync)');
});

test('docs/INDEX.md: plugin version on line 1, every command, error page and spec listed', () => {
  const index = readFileSync(join(PLUGIN, 'docs', 'INDEX.md'), 'utf8');
  const version = JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8')).version;
  assert.equal(index.split(/\r?\n/)[0], `analucia docs for plugin version ${version}`);
  for (const code of Object.keys(ERRORS)) assert.ok(index.includes(`(errors/${code}.md)`), `INDEX lists ${code}`);
  for (const f of readdirSync(join(REPO, 'core')).filter((n) => n.endsWith('.md'))) {
    const t = readFileSync(join(REPO, 'core', f), 'utf8');
    assert.ok(index.includes(`\`core/${f}\` — ${/^id: (\S+)/m.exec(t)[1]} version ${/^version: (\S+)/m.exec(t)[1]}`), `INDEX lists ${f} with its version`);
  }
  const usage = run([]).stderr;
  for (const cmd of ['validate', 'event append', 'verify-log', 'derive', 'history', 'run start', 'run finish', 'verify', 'close', 'halt', 'resume', 'check-writeback', 'agents-md sync', 'check-roles', 'check-push', 'install-git-hooks', 'explain']) {
    assert.ok(usage.includes(`aos ${cmd}`), `usage lists ${cmd}`);
    assert.ok(index.includes(`\`aos ${cmd}`) || index.includes(`/ aos ${cmd}`), `INDEX lists ${cmd}`);
  }
});

test('aos explain: known code prints its page (exit 0); unknown code exits 2 with close matches', () => {
  const ok = run(['explain', 'E_TRANSITION']);
  assert.equal(ok.status, 0);
  // The page as written, with its aos commands turned into the ones that exist on this machine (ORD-0029 B).
  assert.equal(ok.stdout, renderCommands(readFileSync(join(PLUGIN, 'docs', 'errors', 'E_TRANSITION.md'), 'utf8')));
  assert.doesNotMatch(ok.stdout, /node plugins\/analucia\/bin\/aos\.mjs|\baos history/);
  assert.equal(run(['explain', 'e_owner_tty']).status, 0, 'case-insensitive');
  const bad = run(['explain', 'E_TRANSITON']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /E_UNKNOWN_CODE .*close matches: E_TRANSITION/);
  assert.equal(run(['explain', 'E_NOT_A_REAL_CODE']).status, 2);
});
