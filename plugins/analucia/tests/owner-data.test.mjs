// ORD-0043 part 14 (OBS-171): owner data and facts of git. `project.json` may carry `owner_data`, a list of path
// patterns of the files only the owner writes; `aos init` asks for them once (empty by default); the PreToolUse hook
// refuses, for every agent role, a write or a delete on a path that matches (E_OWNER_DATA), and reading stays free;
// `aos tracked <path>…` says, from git, whether each path is under version control, ignored (by which rule of which
// file) or neither.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { blockTemplate, matchesOwnerData, ownerDataPaths, preToolUse } from '../lib/guards.mjs';
import { logPath } from '../lib/log.mjs';
import { QUESTIONS, normalize, onboardingStarted, runInit } from '../lib/onboarding.mjs';
import { validateProjectText } from '../lib/validate.mjs';
import { wizard } from '../lib/wizard.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env };
delete env.CLAUDE_PROJECT_DIR;
delete env.CLAUDE_CODE_SESSION_ID;
const aos = (root, args, input = '') => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input, env });
const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' });

function project(owner_data) {
  const root = mkdtempSync(join(tmpdir(), 'aos-ownerdata-'));
  mkdirSync(join(root, '.analucia'), { recursive: true });
  writeFileSync(join(root, '.analucia', 'project.json'), `${JSON.stringify({ wip_limit: 1, locale: 'en', ...(owner_data ? { owner_data } : {}) })}\n`);
  writeFileSync(logPath(root), '');
  return root;
}
const call = (root, tool_name, tool_input) => preToolUse(root, { tool_name, tool_input });
const PATTERNS = ['data/prices.csv', 'controls/*.xlsx', 'rates.*', 'owner/**'];

test('owner_data in project.json: a list of strings, nothing else', () => {
  const codes = (v) => validateProjectText(`${JSON.stringify({ wip_limit: 1, owner_data: v })}\n`, 'project.json').map((e) => e.code);
  assert.deepEqual(codes(PATTERNS), []);
  assert.deepEqual(codes([]), []);
  assert.deepEqual(codes('prices.csv'), ['E_FIELD_TYPE']);
  assert.deepEqual(codes([1]), ['E_FIELD_TYPE']);
  assert.deepEqual(codes(['']), ['E_FIELD_TYPE']);
});

test('the patterns: a full path or a glob from the project root; a pattern with no slash names a file at any depth', () => {
  const m = (p, rel) => matchesOwnerData([p], rel);
  assert.ok(m('data/prices.csv', 'data/prices.csv'));
  assert.ok(!m('data/prices.csv', 'other/data/prices.csv'));
  assert.ok(m('controls/*.xlsx', 'controls/a.xlsx'));
  assert.ok(!m('controls/*.xlsx', 'controls/old/a.xlsx'), '* stops at a slash');
  assert.ok(m('owner/**', 'owner/a/b/c.txt'));
  assert.ok(m('rates.*', 'rates.csv') && m('rates.*', 'deep/er/rates.json'), 'no slash: any depth');
  assert.ok(!m('rates.*', 'rates'), 'the dot is a dot');
  assert.ok(m('./data/prices.csv', 'data/prices.csv'), 'a leading ./ is the same path');
  assert.ok(m('DATA/Prices.csv', 'data/prices.csv') === (process.platform === 'win32'), 'case follows the platform');
});

test('the hook refuses a write or a delete on a path of owner_data, for the file tools and the shell; reading stays free', () => {
  const root = project(PATTERNS);
  for (const [tool, input] of [
    ['Write', { file_path: join(root, 'data', 'prices.csv'), content: 'x' }],
    ['Edit', { file_path: 'data/prices.csv', old_string: 'a', new_string: 'b' }],
    ['MultiEdit', { file_path: 'controls/c.xlsx', edits: [] }],
    ['Write', { file_path: 'sub/rates.csv', content: 'x' }],
    ['Bash', { command: 'echo 5 > data/prices.csv' }],
    ['Bash', { command: 'printf x >> "owner/notes/a.txt"' }],
    ['Bash', { command: 'rm data/prices.csv' }],
    ['Bash', { command: 'cp new.csv controls/c.xlsx' }],
    ['Bash', { command: 'sed -i s/a/b/ rates.json' }],
    ['PowerShell', { command: 'Set-Content -Path data/prices.csv -Value 1' }],
    ['PowerShell', { command: 'Remove-Item controls/c.xlsx' }],
    ['Bash', { command: 'node -e "require(\'fs\').writeFileSync(\'data/prices.csv\', \'x\')"' }],
  ]) {
    const message = call(root, tool, input);
    assert.match(message ?? '', /E_OWNER_DATA/, `${tool} ${JSON.stringify(input)}`);
    assert.match(message, /tell the owner what should change and why/i);
  }
  for (const [tool, input] of [
    ['Read', { file_path: join(root, 'data', 'prices.csv') }],
    ['Grep', { pattern: 'x', path: 'data/prices.csv' }],
    ['Write', { file_path: 'data/other.csv', content: 'x' }],
    ['Write', { file_path: 'src/app.js', content: 'x' }],
    ['Bash', { command: 'cat data/prices.csv' }],
    ['Bash', { command: 'cat data/prices.csv > /tmp/copy.csv' }],
    ['Bash', { command: 'echo 5 > data/other.csv' }],
    ['Bash', { command: 'git diff -- data/prices.csv' }],
    ['PowerShell', { command: 'Get-Content data/prices.csv' }],
  ]) {
    assert.equal(call(root, tool, input), null, `${tool} ${JSON.stringify(input)}`);
  }
  assert.deepEqual(ownerDataPaths(root, { tool_name: 'Bash', tool_input: { command: 'rm data/prices.csv owner/x.txt data/other.csv' } }).sort(), ['data/prices.csv', 'owner/x.txt']);
  // A project with no owner_data (or an empty list) refuses nothing.
  for (const none of [project(), project([])]) assert.equal(call(none, 'Write', { file_path: 'data/prices.csv', content: 'x' }), null);
});

test('through the hook command: exit 2 with the code and its next step; a path outside the project is not ours to judge', () => {
  const root = project(PATTERNS);
  const run = (input) => spawnSync(process.execPath, [AOS, 'hook', 'pre-tool-use'], { encoding: 'utf8', cwd: root, env, input: JSON.stringify({ cwd: root, ...input }) });
  const r = run({ tool_name: 'Write', tool_input: { file_path: 'data/prices.csv', content: 'x' } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /E_OWNER_DATA/);
  assert.match(r.stderr, /next \(executor\): /);
  assert.match(r.stderr, /docs\/errors\/E_OWNER_DATA\.md/);
  assert.equal(run({ tool_name: 'Read', tool_input: { file_path: 'data/prices.csv' } }).status, 0);
  assert.equal(run({ tool_name: 'Write', tool_input: { file_path: join(tmpdir(), 'data', 'prices.csv'), content: 'x' } }).status, 0);
  assert.ok(readFileSync(join(AOS, '..', '..', 'docs', 'errors', 'E_OWNER_DATA.md'), 'utf8').includes('Who acts: `executor`'));
});

test('aos init asks for the owner data once, empty by default; the answer is written to project.json', async () => {
  const owner = QUESTIONS.find((q) => q.key === 'owner_data');
  assert.ok(owner && owner.type === 'list' && owner.def() instanceof Array && owner.def().length === 0);
  assert.deepEqual(normalize(owner, 'data/prices.csv, controls/*.xlsx'), ['data/prices.csv', 'controls/*.xlsx']);
  const ANSWERS = { purpose: 'A scratch project', github_owner: 'none', owner_locale: 'en' };
  const init = async (root, provided) => {
    const lines = [];
    await runInit(root, { provided: { ...ANSWERS, ...provided }, locale: 'en', isTTY: true, ask: async () => 'CONFIRM', out: (s) => lines.push(s), onConfirmed: () => { if (!existsSync(logPath(root))) onboardingStarted(root); } });
    return lines.join('\n');
  };
  const root = mkdtempSync(join(tmpdir(), 'aos-ownerdata-init-'));
  const said = await init(root, { owner_data: ['data/prices.csv', 'controls/*.xlsx'] });
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.analucia', 'project.json'), 'utf8')).owner_data, ['data/prices.csv', 'controls/*.xlsx']);
  assert.match(said, /owner_data/);
  // Empty by default: no key, and no "not known" notice for a question that is allowed to stay empty.
  const empty = mkdtempSync(join(tmpdir(), 'aos-ownerdata-init-'));
  const text = await init(empty, {});
  assert.equal('owner_data' in JSON.parse(readFileSync(join(empty, '.analucia', 'project.json'), 'utf8')), false);
  assert.doesNotMatch(text, /owner_data.*safe value|safe value.*\[\]/);
  // Later: a second run with new patterns adds them; one that gives none keeps what is there.
  await init(root, { owner_data: ['data/prices.csv', 'controls/*.xlsx', 'rates.*'] });
  assert.equal(JSON.parse(readFileSync(join(root, '.analucia', 'project.json'), 'utf8')).owner_data.length, 3);
  await init(root, {});
  assert.equal(JSON.parse(readFileSync(join(root, '.analucia', 'project.json'), 'utf8')).owner_data.length, 3);
});

test('the wizard asks the owner data after its questions (and the code), and asks it once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aos-ownerdata-wiz-'));
  mkdirSync(join(root, '.analucia'), { recursive: true });
  const prompts = [];
  // Answers by what is asked: option 1 for every question, "none" for the account (no remote to detect), the owner
  // data as given, Enter for the rest (the summary, the project code).
  const run = (ownerData) => wizard(root, {
    locale: 'en',
    ask: async (q) => {
      prompts.push(q);
      assert.ok(prompts.length < 100, 'the wizard keeps asking');
      if (/only yours to write/i.test(q)) return ownerData;
      if (/Question 5 of 15/.test(q)) return '2';
      return /Question \d+ of 15/.test(q) ? '1' : '';
    },
    out: () => {},
  });
  const r = await run('data/prices.csv, controls/*.xlsx');
  assert.deepEqual(r.provided.owner_data, ['data/prices.csv', 'controls/*.xlsx']);
  assert.ok(prompts.some((p) => /only yours to write/i.test(p)), 'the question was asked');
  // Enter: nothing provided, so the default (empty) stands.
  const again = await run('');
  assert.equal('owner_data' in again.provided, false);
});

test('aos tracked: under version control, ignored (by which rule of which file), or neither; it changes nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'aos-tracked-'));
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, '.gitignore'), '*.secret\nbuild/\n');
  mkdirSync(join(root, 'sub'), { recursive: true });
  writeFileSync(join(root, 'sub', '.gitignore'), 'local.txt\n');
  writeFileSync(join(root, 'tracked.txt'), 'x');
  writeFileSync(join(root, 'prices.secret'), 'x');
  mkdirSync(join(root, 'build'), { recursive: true });
  writeFileSync(join(root, 'build', 'out.js'), 'x');
  writeFileSync(join(root, 'sub', 'local.txt'), 'x');
  writeFileSync(join(root, 'untracked.txt'), 'x');
  git(root, 'add', 'tracked.txt', '.gitignore', 'sub/.gitignore');
  git(root, 'commit', '-q', '-m', 'base');
  const r = aos(root, ['tracked', 'tracked.txt', 'prices.secret', 'build/out.js', 'sub/local.txt', 'untracked.txt', 'missing.txt']);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 6);
  assert.equal(lines[0], 'tracked.txt: under version control');
  assert.match(lines[1], /^prices\.secret: ignored by the rule "\*\.secret" of \.gitignore:1$/);
  assert.match(lines[2], /^build\/out\.js: ignored by the rule "build\/" of \.gitignore:2$/);
  assert.match(lines[3], /^sub\/local\.txt: ignored by the rule "local\.txt" of sub\/\.gitignore:1$/);
  assert.equal(lines[4], 'untracked.txt: neither (not under version control and not ignored)');
  assert.equal(lines[5], 'missing.txt: neither (not under version control and not ignored)');
  // A file that is tracked and also matches an ignore rule is under version control (git still tracks it).
  git(root, 'add', '-f', 'prices.secret');
  assert.equal(aos(root, ['tracked', 'prices.secret']).stdout.trim(), 'prices.secret: under version control');
  assert.equal(aos(root, ['tracked']).status, 2, 'usage');
  const plain = mkdtempSync(join(tmpdir(), 'aos-tracked-plain-'));
  mkdirSync(join(plain, '.analucia'), { recursive: true });
  const none = aos(plain, ['tracked', 'a.txt']);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /not inside a git repository/);
});

test('the rules block says it, in one line each', () => {
  const block = blockTemplate();
  assert.match(block, /`aos tracked <path>`/);
  assert.match(block, /`owner_data`/);
});
