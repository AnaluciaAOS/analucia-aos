// ORD-0030: the release manifest (public and private lists) and the command that builds the public tree from it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'build-public-tree.mjs');
const { parseManifest, classify, globToRegExp, MANIFEST } = await import(pathToFileURL(SCRIPT).href);
const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' });
const build = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

test('globs: "*" stays in one folder, "**" matches any depth, the rest is literal', () => {
  assert.ok(globToRegExp('docs/**').test('docs/a/b.md'));
  assert.ok(globToRegExp('core/*.md').test('core/A.md'));
  assert.ok(!globToRegExp('core/*.md').test('core/x/A.md'));
  assert.ok(!globToRegExp('a.b').test('axb'));
});

test('the manifest has a public and a private list, every private entry has a reason, and it covers every tracked file', () => {
  const m = parseManifest(readFileSync(join(ROOT, MANIFEST), 'utf8'));
  assert.deepEqual(m.problems, []);
  assert.ok(m.public.length > 0 && m.private.length > 0);
  for (const e of [...m.private, ...m.refs]) assert.ok(e.reason.length > 10, `line ${e.line}: reason`);
  const priv = (p) => m.private.some((e) => e.re.test(p));
  for (const p of ['.analucia/project.json', '.analucia/events.jsonl', '.analucia/evidence/ORD-0001/report.md', '.analucia/orders/ORD-0001.md']) assert.ok(priv(p), p);
  assert.ok(m.refs.some((r) => r.ref.startsWith('refs/remotes/origin/backup/')), 'the backup branch is listed as a ref');
  assert.ok(m.public.some((e) => e.re.test('.analucia/project.example.json')), 'the neutral owner template is public');
  const tracked = git(ROOT, 'ls-files').stdout.split('\n').filter(Boolean);
  assert.deepEqual(classify(tracked, m).unlisted, []);
});

test('the neutral owner template is valid project configuration with placeholder values', () => {
  const t = JSON.parse(readFileSync(join(ROOT, '.analucia', 'project.example.json'), 'utf8'));
  assert.equal(t.github_owner, 'example');
  assert.equal(t.timezone, 'UTC');
});

function fixture({ manifest }) {
  const root = mkdtempSync(join(tmpdir(), 'aos-release-'));
  git(root, 'init', '-q', '-b', 'main');
  for (const [p, body] of Object.entries({ 'docs/a.md': 'a\n', 'docs/deep/b.md': 'b\n', 'keep.txt': 'k\n', '.analucia/project.json': '{}\n', [MANIFEST]: manifest })) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), body);
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'fixture');
  return root;
}
const MANIFEST_OK = `[public]\ndocs/**\nkeep.txt\n${MANIFEST}\n.analucia/**\n[private]\n.analucia/project.json  # owner configuration with real values\nref: refs/heads/backup/x  # a backup branch\n`;

test('build: copies the public files from the ref and nothing private; no repository is created', () => {
  const root = fixture({ manifest: MANIFEST_OK });
  const out = join(mkdtempSync(join(tmpdir(), 'aos-public-')), 'tree');
  const r = build(out, '--repo', root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /5 tracked file\(s\): 4 public, 1 private, 0 unlisted/);
  assert.ok(existsSync(join(out, 'docs', 'deep', 'b.md')));
  assert.ok(!existsSync(join(out, '.analucia', 'project.json')), 'private wins over a public glob');
  assert.ok(!existsSync(join(out, '.git')), 'no git init');
  assert.equal(git(root, 'status', '--porcelain').stdout, '', 'the repository is unchanged');
});

test('build: refuses a folder inside the repository, a folder that is not empty, an unlisted file and a private entry without a reason', () => {
  const root = fixture({ manifest: MANIFEST_OK });
  assert.equal(build(join(root, 'out'), '--repo', root).status, 2);
  assert.ok(!existsSync(join(root, 'out')));
  const full = mkdtempSync(join(tmpdir(), 'aos-public-'));
  writeFileSync(join(full, 'x'), 'x');
  assert.equal(build(full, '--repo', root).status, 2);
  assert.deepEqual(readdirSync(full), ['x']);
  const unlisted = fixture({ manifest: `[public]\ndocs/**\n${MANIFEST}\n[private]\n.analucia/project.json  # owner configuration\n` });
  const r = build(join(tmpdir(), `aos-public-none-${process.pid}`), '--repo', unlisted, '--dry-run');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unlisted \(not copied\): keep\.txt/);
  const noReason = fixture({ manifest: `[public]\n**\n[private]\n.analucia/project.json\n` });
  const n = build(join(tmpdir(), `aos-public-none-${process.pid}`), '--repo', noReason, '--dry-run');
  assert.equal(n.status, 1);
  assert.match(n.stderr, /needs "  # <reason>"/);
});
