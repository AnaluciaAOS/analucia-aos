// ORD-0024: aos backup, the recovery recipe and the owner items, the readable review page, the decision brief.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { backupBranch } from '../lib/backup.mjs';
import { readLog } from '../lib/log.mjs';
import { escapeHtml, renderMarkdown, reviewPage, writeReviewPage } from '../lib/markdown.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const TEMPLATES = fileURLToPath(new URL('../templates/', import.meta.url));
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
delete env.CLAUDE_PROJECT_DIR;
const aos = (root, args) => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input: '', env });
const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8', env });
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

// A project on main, pushed to a local bare remote, then: a tracked file changed, a staged change, an untracked file
// and an ignored file.
function project() {
  const root = mkdtempSync(join(tmpdir(), 'aos-bk-'));
  const bare = mkdtempSync(join(tmpdir(), 'aos-bk-bare-'));
  git(bare, 'init', '-q', '--bare');
  mkdirSync(join(root, '.analucia'));
  writeFileSync(join(root, '.analucia', 'project.json'), '{"wip_limit":1,"locale":"en","timezone":"America/Lima"}\n');
  writeFileSync(join(root, '.analucia', 'events.jsonl'), '');
  writeFileSync(join(root, '.gitignore'), 'ignored.txt\n');
  writeFileSync(join(root, 'tracked.txt'), 'one\n');
  writeFileSync(join(root, 'staged.txt'), 'first\n');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 't');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  git(root, 'remote', 'add', 'origin', bare);
  git(root, 'push', '-q', '--no-verify', '-u', 'origin', 'main');
  writeFileSync(join(root, 'tracked.txt'), 'one, changed\n');
  writeFileSync(join(root, 'staged.txt'), 'second\n');
  git(root, 'add', 'staged.txt');
  writeFileSync(join(root, 'notes.md'), '# Untracked notes\n');
  writeFileSync(join(root, 'ignored.txt'), 'never saved\n');
  return { root, bare };
}
// Everything a backup must leave as it was (the log is the only file it appends to).
function untouched(root) {
  const index = sha(readFileSync(join(root, '.git', 'index')));
  return {
    index,
    head: git(root, 'rev-parse', 'HEAD').stdout.trim(),
    branch: git(root, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.trim(),
    main: git(root, 'rev-parse', 'refs/heads/main').stdout.trim(),
    originMain: git(root, 'rev-parse', 'refs/remotes/origin/main').stdout.trim(),
    files: ['tracked.txt', 'staged.txt', 'notes.md', 'ignored.txt'].map((f) => readFileSync(join(root, f), 'utf8')),
    status: git(root, 'status', '--porcelain', '--', '.', ':!.analucia/events.jsonl').stdout,
    staged: git(root, 'diff', '--cached', '--name-only').stdout,
  };
}

test('aos backup pushes a snapshot with uncommitted and untracked work, and never touches the branch, index, tree or main', () => {
  const { root, bare } = project();
  const before = untouched(root);
  const r = aos(root, ['backup']);
  assert.equal(r.status, 0, r.stderr);
  const branch = backupBranch(root);
  assert.match(branch, /^backup\/\d{4}-\d{2}-\d{2}$/);
  assert.equal(r.stdout, `Saved 6 files, including work not committed yet, to the branch ${branch} on origin. To bring it back: aos backup --restore-hint\n`);
  assert.deepEqual(untouched(root), before, 'branch, HEAD, main, origin/main, the index and the working tree are unchanged');
  assert.equal(git(bare, 'rev-parse', 'refs/heads/main').stdout.trim(), before.main, 'main on the remote is unchanged');
  const files = git(bare, 'ls-tree', '-r', '--name-only', branch).stdout.split('\n').filter(Boolean);
  assert.deepEqual(files, ['.analucia/events.jsonl', '.analucia/project.json', '.gitignore', 'notes.md', 'staged.txt', 'tracked.txt'], 'the untracked file is in, the ignored one is not');
  assert.equal(git(bare, 'show', `${branch}:tracked.txt`).stdout, 'one, changed\n', 'the uncommitted change is in the snapshot');
  assert.equal(git(bare, 'show', `${branch}:staged.txt`).stdout, 'second\n');
  const e = readLog(root).events.at(-1);
  assert.equal(e.type, 'backup.pushed');
  assert.deepEqual(e.payload, { branch, commit: git(bare, 'rev-parse', branch).stdout.trim(), files: files.length, remote: 'origin' });
  // A second backup the same day goes on top of the first (a fast-forward, never forced).
  const first = e.payload.commit;
  writeFileSync(join(root, 'notes.md'), '# Untracked notes, more\n');
  assert.equal(aos(root, ['backup']).status, 0);
  const second = git(bare, 'rev-parse', branch).stdout.trim();
  assert.notEqual(second, first);
  assert.equal(git(bare, 'merge-base', '--is-ancestor', first, second).status, 0);
  // The restore hint names the latest branch and commands that do not touch the current work.
  const h = aos(root, ['backup', '--restore-hint']);
  assert.equal(h.status, 0);
  assert.equal(h.stdout, `The latest backup is ${branch} on origin. To restore it in a new folder next to this one, without touching your current work:\n  git fetch origin ${branch}\n  git worktree add ../restore-${branch.slice(7)} FETCH_HEAD\n`);
  assert.equal(aos(root, ['validate']).status, 0);
});

test('aos backup refuses when the snapshot holds a secret or an environment file: nothing is pushed, values never shown', () => {
  const { root, bare } = project();
  const fake = ['ghp', '_', 'A1b2'.repeat(10)].join('');
  writeFileSync(join(root, 'notes.md'), `# Notes\n\ntoken: ${fake}\n`);
  writeFileSync(join(root, '.env.local'), 'API_KEY=x\n');
  const r = aos(root, ['backup']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Nothing was saved: 2 place\(s\) look like a secret/);
  assert.match(r.stderr, /notes\.md:3 matches github_token/);
  assert.match(r.stderr, /\.env\.local is an environment file/);
  assert.match(r.stderr, /aos backup: E_SECRET /);
  assert.ok(!r.stderr.includes(fake) && !r.stdout.includes(fake) && !r.stderr.includes(fake.slice(4, 16)), 'the value is never printed');
  assert.equal(git(bare, 'ls-remote', '--heads', bare, 'backup/*').stdout, '', 'no backup branch on the remote');
  assert.ok(!readLog(root).events.some((e) => e.type === 'backup.pushed'));
  assert.equal(aos(root, ['backup', '--restore-hint']).status, 1);
});

test('the renderer escapes every piece of HTML in the document and keeps only safe links', () => {
  const html = renderMarkdown([
    '# Title <script>alert(1)</script>',
    '',
    'Text with <img src=x onerror=alert(1)> and **bold <b>x</b>** and `<code>` & "quotes".',
    '',
    '| Option | Cost |',
    '|---|---|',
    '| <i>A</i> | **$1** |',
    '',
    '[ok](https://example.com/a?b=1&c=2) [bad](javascript:alert(1)) [inject](https://a.example/"onmouseover="x)',
    '',
    '```',
    '<div>raw</div>',
    '```',
  ].join('\n'));
  // No live tag, no unsafe href, no break-out of an attribute (escaped text such as "onerror=" is harmless).
  assert.doesNotMatch(html, /<script|<img|<i>|<b>|<div>|href="javascript|"onmouseover/);
  assert.match(html, /<h1>Title &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/h1>/);
  assert.match(html, /<strong>bold &lt;b&gt;x&lt;\/b&gt;<\/strong>/);
  assert.match(html, /<code>&lt;code&gt;<\/code> &amp; &quot;quotes&quot;/);
  assert.match(html, /<td>&lt;i&gt;A&lt;\/i&gt;<\/td><td><strong>\$1<\/strong><\/td>/);
  assert.match(html, /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2">ok<\/a>/);
  assert.match(html, /\[bad\]\(javascript:alert\(1\)\)/, 'an unsafe link stays text');
  assert.match(html, /<pre><code>&lt;div&gt;raw&lt;\/div&gt;<\/code><\/pre>/);
  assert.equal(escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
});

test('the renderer supports the subset of the decision brief: headings, paragraphs, lists, tables, bold, code, links', () => {
  const html = renderMarkdown('## Options\n\nOne\nparagraph.\n\n- a\n- b\n\n1. first\n2. second\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\nSee [the docs](docs/INDEX.md) and `aos sign`.\n');
  assert.equal(html, [
    '<h2>Options</h2>',
    '<p>One paragraph.</p>',
    '<ul><li>a</li><li>b</li></ul>',
    '<ol><li>first</li><li>second</li></ol>',
    '<table><thead><tr><th>x</th><th>y</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
    '<p>See <a href="docs/INDEX.md">the docs</a> and <code>aos sign</code>.</p>',
  ].join('\n'));
  const brief = renderMarkdown(readFileSync(join(TEMPLATES, 'decision-brief.md'), 'utf8'));
  assert.match(brief, /<h1>Decision brief: &lt;one short title&gt;<\/h1>/);
  assert.match(brief, /<table>[\s\S]*<strong>A \(recommended\)<\/strong>/);
});

test('the review page is a whole HTML page written under the temp folder, never in the repository', () => {
  const page = reviewPage('# Hi', { title: 'A <title>', meta: 'ORD-0001 · docs/a.md' });
  assert.match(page, /^<!doctype html>/);
  assert.match(page, /<title>A &lt;title&gt;<\/title>/);
  assert.match(page, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(page, /prefers-color-scheme:dark/);
  const file = writeReviewPage('# Plan\n', { name: 'docs/plan.md', title: 'Plan' });
  assert.ok(file.startsWith(tmpdir()) && file.endsWith('plan.html') && !file.startsWith(REPO), file);
  assert.match(readFileSync(file, 'utf8'), /<h1>Plan<\/h1>/);
});

test('the decision brief exists in English and Spanish with every section; HUMAN-LAYER.md says when the director writes one', () => {
  const en = readFileSync(join(TEMPLATES, 'decision-brief.md'), 'utf8');
  const es = readFileSync(join(TEMPLATES, 'decision-brief.es.md'), 'utf8');
  for (const h of ['## The idea in one sentence', '## Why now', '## What changes for you', '## Options', '## Recommendation and why', '## What we need from you', '## How to undo it', '## Sources', '**For:**', '**Order:**', '**Version:**', '**Date:**', '(recommended)', 'approve', 'choose', 'give one fact']) assert.ok(en.includes(h), `en: ${h}`);
  for (const h of ['## La idea en una frase', '## Por qué ahora', '## Qué cambia para ti', '## Opciones', '## Recomendación y por qué', '## Qué necesitamos de ti', '## Cómo deshacerlo', '## Fuentes', '(recomendada)']) assert.ok(es.includes(h), `es: ${h}`);
  assert.equal((en.match(/^## /gm) ?? []).length, (es.match(/^## /gm) ?? []).length, 'same sections in both');
  assert.match(readFileSync(join(REPO, 'plugins', 'analucia', 'docs', 'HUMAN-LAYER.md'), 'utf8'), /## When the director writes you a decision brief/);
});

test('the recovery recipe uses only commands that exist; the checklist has the three owner items', () => {
  const recipe = readFileSync(join(REPO, 'docs', 'RECOVERY.md'), 'utf8').replace(/\r\n/g, '\n');
  const usage = spawnSync(process.execPath, [AOS], { encoding: 'utf8', env }).stderr;
  const aosCommands = [...recipe.matchAll(/^node plugins\/analucia\/bin\/aos\.mjs ([a-z-]+)/gm)].map((m) => m[1]);
  assert.deepEqual([...new Set(aosCommands)].sort(), ['backup', 'init', 'install-git-hooks', 'verify-log']);
  for (const c of aosCommands) assert.ok(usage.includes(`aos ${c}`), `aos ${c} is a command`);
  for (const l of ['git clone ', 'git fetch origin "refs/heads/backup/*', 'git for-each-ref ', 'git switch -c restore-', 'node --test plugins/analucia/tests', 'claude plugin install analucia@analucia-aos --scope project']) assert.ok(recipe.includes(l), l);
  assert.match(recipe, /## What the repository alone cannot rebuild/);
  const checklist = readFileSync(join(REPO, 'docs', 'RELEASE-CHECKLIST.md'), 'utf8');
  for (const l of ['password manager', 'encrypted copy of the reserved files', 'recovery recipe was read once']) assert.ok(checklist.includes(l), l);
});
