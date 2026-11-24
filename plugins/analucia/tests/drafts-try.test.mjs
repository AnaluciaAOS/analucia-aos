// ORD-0047 part 12 (OBS-189): `aos drafts --try <draft>` tries every check of a draft's verify file before it is placed:
// (a) the command parses, (b) its patterns compile, (c) the checks that need neither the order's commit nor its report
// run on the real tree. It says which pass, which fail, which cannot run yet, and which have a problem of their own text.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { grepPatterns, tryDraft, tryLines } from '../lib/drafts-try.mjs';
import { logPath } from '../lib/log.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const aos = (root, args) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input: '', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });

function project(verify, { topic = 'tried' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aos-try-'));
  const a = join(root, '.analucia');
  for (const d of ['drafts', 'orders', 'verify', 'evidence']) mkdirSync(join(a, d), { recursive: true });
  writeFileSync(join(a, 'project.json'), `${JSON.stringify({ wip_limit: 1, locale: 'en', project_code: 'DEMO' })}\n`);
  writeFileSync(logPath(root), '');
  writeFileSync(join(root, 'present.txt'), 'hello world\n');
  const d = join(a, 'drafts');
  writeFileSync(join(d, `draft-${topic}.md`), ['---', 'id: {id}', 'title: Try me', 'kind: fix', 'created: 2026-11-22', 'budget_max_minutes: 30', 'budget_max_attempts: 3', 'risk: low', 'cost_effect: none', '---', '', '## Acceptance criteria', '', '- [ ] x', ''].join('\n'));
  writeFileSync(join(d, `draft-${topic}.json`), `${JSON.stringify({ order: '{id}', ...verify }, null, 2)}\n`);
  writeFileSync(join(d, `draft-${topic}.request.md`), '- a point => the draft\n');
  return root;
}
const by = (r, name) => r.results.find((x) => x.name === name);

test('the patterns of the grep calls are read from the command', () => {
  assert.deepEqual(grepPatterns('grep -q \'hello\' f.txt && grep -Eq "a|b" g'), [{ flags: '-q', pattern: 'hello' }, { flags: '-Eq', pattern: 'a|b' }]);
  assert.deepEqual(grepPatterns('echo no grep pattern here'), []);
});

test('each check is tried: pass, fail on the tree, cannot run yet, and the ones with a problem of their own text', () => {
  const root = project({
    preflight: [{ name: 'tool is there', run: 'test -f present.txt', expect_exit: 0 }],
    checks: [
      { name: 'passes now', run: 'grep -q hello present.txt', expect_exit: 0 },
      { name: 'not built yet', run: 'test -f not-built-yet.txt', expect_exit: 0 },
      { name: 'does not parse', run: 'if [ -f present.txt ; then echo x', expect_exit: 0 },
      { name: 'bad pattern', run: "grep -Eq '(unclosed' present.txt", expect_exit: 0 },
      { name: 'needs the commit', run: 'git merge-base --is-ancestor HEAD {order_commit}', expect_exit: 0 },
      { name: 'needs the report', run: "grep -q '^OUTCOME: ' .analucia/evidence/{id}/report.md", expect_exit: 0 },
    ],
    report_lines: [{ name: 'fine line', pattern: '^Work: complete$' }, { name: 'broken line', pattern: '(^Work' }],
  });
  const r = tryDraft(root, 'tried');
  assert.equal(r.id, 'DEMO-0001', 'a draft named by topic is tried as the ID it would get now');
  assert.equal(by(r, 'tool is there').status, 'pass');
  assert.equal(by(r, 'passes now').status, 'pass');
  assert.equal(by(r, 'not built yet').status, 'fail');
  assert.equal(by(r, 'does not parse').status, 'own');
  assert.match(by(r, 'does not parse').why, /does not parse \(bash -n\)/);
  assert.equal(by(r, 'bad pattern').status, 'own');
  assert.match(by(r, 'bad pattern').why, /does not compile/);
  assert.equal(by(r, 'needs the commit').status, 'cannot');
  assert.equal(by(r, 'needs the report').status, 'cannot');
  assert.equal(by(r, 'fine line').status, 'pass');
  assert.equal(by(r, 'broken line').status, 'own');
  assert.equal(r.ok, false);
  assert.equal(r.problems.length, 3, r.problems.join('\n'));
  const text = tryLines(r).join('\n');
  assert.match(text, /\[FIX: its own text\] check "does not parse"/);
  assert.match(text, /\[cannot run yet\] check "needs the commit"/);
  assert.match(text, /\[fail on the real tree now\] check "not built yet"/);
});

test('a failing preflight check is a problem; a draft whose checks are all fine exits 0 through the command', () => {
  const bad = project({ preflight: [{ name: 'tool missing', run: 'test -f nowhere.txt', expect_exit: 0 }], checks: [] });
  const r = tryDraft(bad, 'tried');
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /must pass on the untouched tree/);
  assert.equal(aos(bad, ['drafts', '--try', 'tried']).status, 1);

  const good = project({ preflight: [{ name: 'present', run: 'test -f present.txt', expect_exit: 0 }], checks: [{ name: 'later', run: 'test -f later.txt', expect_exit: 0 }, { name: 'commit', run: 'git rev-parse {order_commit}', expect_exit: 0 }] });
  const cli = aos(good, ['drafts', '--try', 'draft-tried']);
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.match(cli.stdout, /draft-tried \(would be DEMO-0001, not yet given\): 3 check\(s\) tried/);
  assert.match(cli.stdout, /1 pass · 1 fail on the real tree now · 1 cannot run yet · 0 to fix/);
});

test('--no-run parses and compiles but runs nothing; an unknown draft and a missing name are refused', () => {
  const root = project({ checks: [{ name: 'would write', run: 'echo x > written.txt', expect_exit: 0 }] });
  const r = tryDraft(root, 'tried', { run: false });
  assert.equal(by(r, 'would write').status, 'cannot');
  assert.equal(aos(root, ['drafts', '--try', 'tried', '--no-run']).status, 0);
  const missing = aos(root, ['drafts', '--try', 'nothing-like-it']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no draft "nothing-like-it"/);
  assert.notEqual(aos(root, ['drafts', '--try']).status, 0);
  assert.equal(existsSync(join(root, 'written.txt')), false, 'nothing was run');
});

test('the director entrypoint says to try the checks before placing', () => {
  const entry = spawnSync(process.execPath, [AOS, 'text', 'has', fileURLToPath(new URL('../templates/director-entry.md', import.meta.url)), 'drafts --try <topic>'], { encoding: 'utf8' });
  assert.equal(entry.status, 0, entry.stderr);
});
