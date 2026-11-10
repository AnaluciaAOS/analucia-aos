#!/usr/bin/env node
// ORD-0030: builds the clean public tree from the release manifest into a folder outside the repository.
// Usage: node scripts/build-public-tree.mjs <folder outside the repository> [--ref <commit or tree>] [--dry-run] [--repo <path>]
// It reads .analucia/release/manifest.txt and the files from the same ref (default HEAD), and copies every tracked
// file that matches a [public] entry and no [private] entry. It never runs git init, commits, pushes, creates a
// repository or publishes anything; the only git commands it runs read objects. It prints counts, paths and hashes.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MANIFEST = '.analucia/release/manifest.txt';

// "*" stays inside one folder, "**" matches any depth; everything else is literal.
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += '.*'; i++; } else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

// The manifest: [public], [private] (each entry "<path or glob or ref: …>  # <reason>") and [notes].
export function parseManifest(text) {
  const out = { public: [], private: [], refs: [], problems: [] };
  let section = null;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const head = /^\[(public|private|notes)\]$/.exec(line);
    if (head) { section = head[1]; return; }
    if (section === 'public') out.public.push({ entry: line, re: globToRegExp(line), line: i + 1 });
    else if (section === 'private') {
      const m = /^(.*?)\s+#\s+(\S.*)$/.exec(line);
      if (!m) { out.problems.push(`line ${i + 1}: a private entry needs "  # <reason>"`); return; }
      const ref = /^ref:\s*(\S+)$/.exec(m[1]);
      if (ref) out.refs.push({ ref: ref[1], reason: m[2], line: i + 1 });
      else out.private.push({ entry: m[1], re: globToRegExp(m[1]), reason: m[2], line: i + 1 });
    } else if (section !== 'notes') out.problems.push(`line ${i + 1}: an entry outside [public] or [private]`);
  });
  return out;
}

// Each tracked path: public, private or unlisted.
export function classify(paths, manifest) {
  const res = { public: [], private: [], unlisted: [] };
  for (const p of paths) {
    if (manifest.private.some((e) => e.re.test(p))) res.private.push(p);
    else if (manifest.public.some((e) => e.re.test(p))) res.public.push(p);
    else res.unlisted.push(p);
  }
  return res;
}

function main(argv) {
  const args = [...argv];
  const take = (flag) => { const i = args.indexOf(flag); if (i < 0) return null; const [, v] = args.splice(i, 2); return v; };
  const root = resolve(take('--repo') ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  const ref = take('--ref') ?? 'HEAD';
  const dryRun = args.includes('--dry-run');
  const outArg = args.find((a) => !a.startsWith('--'));
  if (!outArg) { process.stderr.write('usage: node scripts/build-public-tree.mjs <folder outside the repository> [--ref <commit or tree>] [--dry-run]\n'); return 2; }
  const out = resolve(outArg);
  const rel = relative(root, out);
  if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) { process.stderr.write(`build-public-tree: refused: ${out} is inside the repository; give a folder outside it\n`); return 2; }
  if (!dryRun && existsSync(out) && readdirSync(out).length) { process.stderr.write(`build-public-tree: refused: ${out} is not empty\n`); return 2; }

  const git = (a, opts = {}) => execFileSync('git', ['-C', root, ...a], { maxBuffer: 512 * 1024 * 1024, ...opts });
  const manifest = parseManifest(git(['show', `${ref}:${MANIFEST}`], { encoding: 'utf8' }));
  const entries = git(['ls-tree', '-r', '-z', ref], { encoding: 'utf8' }).split('\0').filter(Boolean).map((l) => {
    const [info, path] = l.split('\t');
    const [mode, type, blob] = info.split(' ');
    return { mode, type, blob, path };
  }).filter((e) => e.type === 'blob');
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const c = classify(entries.map((e) => e.path), manifest);
  const digest = createHash('sha256');
  for (const p of c.public) digest.update(`${p}\0${byPath.get(p).blob}\n`);

  process.stdout.write(`build-public-tree: ref ${ref} · ${entries.length} tracked file(s): ${c.public.length} public, ${c.private.length} private, ${c.unlisted.length} unlisted\n`);
  process.stdout.write(`build-public-tree: ${manifest.refs.length} private ref(s) listed (refs are never copied)\n`);
  process.stdout.write(`build-public-tree: public set sha256 ${digest.digest('hex').slice(0, 16)}\n`);
  for (const p of manifest.problems) process.stderr.write(`build-public-tree: manifest ${p}\n`);
  for (const p of c.unlisted) process.stderr.write(`build-public-tree: unlisted (not copied): ${p}\n`);
  if (manifest.problems.length || c.unlisted.length) return 1;
  if (dryRun) { process.stdout.write('build-public-tree: dry run, nothing written\n'); return 0; }

  const data = git(['cat-file', '--batch'], { input: c.public.map((p) => byPath.get(p).blob).join('\n') + '\n' });
  const blobs = new Map();
  for (let pos = 0; pos < data.length;) {
    const nl = data.indexOf(10, pos);
    const [sha, , size] = data.subarray(pos, nl).toString('utf8').split(' ');
    const n = Number(size);
    blobs.set(sha, data.subarray(nl + 1, nl + 1 + n));
    pos = nl + 1 + n + 1;
  }
  for (const p of c.public) {
    const e = byPath.get(p);
    const dest = join(out, ...p.split('/'));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, blobs.get(e.blob));
    if (e.mode === '100755') chmodSync(dest, 0o755);
  }
  process.stdout.write(`build-public-tree: ${c.public.length} file(s) written to ${out}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
