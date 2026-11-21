#!/usr/bin/env node
// ORD-0043 (AMD-0017 item 4): counts scan category 5 (accounts) leaving out the hits inside declared test fixtures.
// Usage: node scripts/scan-fixtures.mjs <scan-output.json | -> [--fixtures <file>]
// Reads the JSON the scanner of the lab folder prints (the scanner is not changed). Prints, and never a name:
//   Scan category 5: <after> after declared fixtures (raw <raw>)
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_FILE = join(HERE, 'release-fixtures.txt');

// One path per line; "#" starts a comment (a line or the reason after the path).
export function declaredFixtures(text) {
  return new Set(text.split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean));
}

// category: one entry of the scanner's "result" (distinct, locations). raw = the scanner's own count.
export function countAfterFixtures(category, declared) {
  const raw = category?.distinct ?? 0;
  const kept = (category?.locations ?? []).filter((l) => !declared.has(String(l.path).split(String.fromCharCode(92)).join('/')));
  return { raw, after: Math.min(raw, kept.length) };
}

export function categoryLine(scan, declared, cat = 'account') {
  const { raw, after } = countAfterFixtures(scan?.result?.[cat], declared);
  return `Scan category 5: ${after} after declared fixtures (raw ${raw})`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const fi = args.indexOf('--fixtures');
  const fixturesPath = fi >= 0 ? args.splice(fi, 2)[1] : FIXTURES_FILE;
  const src = args[0];
  if (!src) { console.error('usage: node scripts/scan-fixtures.mjs <scan-output.json | -> [--fixtures <file>]'); process.exit(2); }
  const scan = JSON.parse(readFileSync(src === '-' ? 0 : src, 'utf8'));
  console.log(categoryLine(scan, declaredFixtures(readFileSync(fixturesPath, 'utf8'))));
}
