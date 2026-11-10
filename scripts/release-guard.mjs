#!/usr/bin/env node
// Release guard (Q-77): fails if any denylisted term appears in a git-tracked file.
// Usage: node scripts/release-guard.mjs <denylist-file>
// Denylist: one term per line, "#" starts a comment, prefix "w:" = whole word. Case-insensitive.
// Output never repeats a term, a matched line or a file name that contains a term (ORD-0026 run 3: a verify report
// quoted the guard's output and so leaked the term into a tracked file). Each match prints
// "<path>:<line>: rule <n> (denylist line <m>)"; a path that itself matches is printed as "tracked file #<k>" (its
// 1-based position in `git ls-files`), and a match in the name is reported as line 0.
// Binary files (image extensions, or a NUL byte in the first 8 KB) are checked by path only, never by content.
// Generated verify reports (.analucia/evidence/**/verify-*.txt) are checked by path only: they quote command output.
// Exit 0 = clean, 1 = at least one match, 2 = denylist missing or unreadable (fail closed).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function fail(message) {
  process.stderr.write(`release-guard: ${message} (fail closed)\n`);
  process.exit(2);
}

const denylistPath = process.argv[2];
if (!denylistPath) fail('no denylist path given');
if (!existsSync(denylistPath) || !statSync(denylistPath).isFile()) fail(`denylist not found: ${denylistPath}`);

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rules = [];
readFileSync(denylistPath, 'utf8').split(/\r?\n/).forEach((raw, i) => {
  const line = raw.trim();
  if (!line || line.startsWith('#')) return;
  const whole = line.toLowerCase().startsWith('w:');
  const term = whole ? line.slice(2).trim() : line;
  if (!term) return;
  const body = escape(term);
  const pattern = whole ? `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])` : body;
  rules.push({ id: rules.length + 1, line: i + 1, re: new RegExp(pattern, 'iu') });
});
if (rules.length === 0) fail(`denylist has no terms: ${denylistPath}`);

let root;
let files;
try {
  root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
} catch {
  fail('cannot list git-tracked files');
}

let matches = 0;
const report = (label, lineNo, rule) => {
  matches++;
  process.stdout.write(`${label}:${lineNo}: rule ${rule.id} (denylist line ${rule.line})\n`);
};

// Binary files are not text: a term can match by chance inside their bytes (ORD-0026: a PNG screenshot). Their content
// is skipped; their path is still checked. Binary = a known image extension, or a NUL byte in the first 8 KB.
const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|ico|bmp|tiff?|avif|heic)$/i;
const isBinary = (file, buf) => IMAGE_EXTENSIONS.test(file) || buf.subarray(0, 8192).includes(0);
const VERIFY_REPORT = /^\.analucia\/evidence\/(?:.+\/)?verify-[^/]*\.txt$/;
let skipped = 0;
let skippedReports = 0;

files.forEach((file, index) => {
  // The path itself counts: a file name can leak a term too. Such a file is named only by its position.
  const nameRules = rules.filter(({ re }) => re.test(file));
  const label = nameRules.length ? `tracked file #${index + 1}` : file;
  for (const rule of nameRules) report(label, 0, rule);
  const abs = join(root, file);
  if (!existsSync(abs) || !statSync(abs).isFile()) return;
  if (VERIFY_REPORT.test(file)) { skippedReports++; return; }
  const buf = readFileSync(abs);
  if (isBinary(file, buf)) { skipped++; return; }
  const lines = buf.toString('utf8').split(/\r?\n/);
  lines.forEach((text, i) => {
    for (const rule of rules) if (rule.re.test(text)) report(label, i + 1, rule);
  });
});

if (skipped) process.stderr.write(`release-guard: ${skipped} binary file(s) checked by path only\n`);
if (skippedReports) process.stderr.write(`release-guard: ${skippedReports} verify report(s) checked by path only\n`);
process.exit(matches > 0 ? 1 : 0);
