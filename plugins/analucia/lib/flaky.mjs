// ORD-0047 part 15 (OBS-200): a test that fails once is named. `aos tests run <ID>` runs the project's tests (part 3's
// command); if any test fails it runs them once more, and records in the evidence folder the name of every test that
// failed in any pass. A test that failed in a pass and passed in the next is "unsteady". `.analucia/flaky.txt` holds the
// unsteady tests the director has accepted, one per line: `<test name> | <reason>`; "#" starts a comment. An unsteady
// test that is not there, or is there with no reason, fails the run, and so does a test that fails in every pass.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runProjectTests } from './not-worse.mjs';

export const FLAKY_REL = '.analucia/flaky.txt';
export const runRel = (id) => `.analucia/evidence/${id}/tests-run.json`;
const MAX_PASSES = 2;

// The accepted tests: Map name -> reason. A line without a reason is not accepted (listed in `noReason`).
export function parseFlaky(text) {
  const accepted = new Map();
  const noReason = [];
  for (const raw of String(text).replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const cut = line.lastIndexOf(' | ');
    const name = (cut < 0 ? line : line.slice(0, cut)).trim();
    const reason = cut < 0 ? '' : line.slice(cut + 3).trim();
    if (reason) accepted.set(name, reason);
    else noReason.push(name);
  }
  return { accepted, noReason };
}

export function readFlaky(root) {
  const p = join(root, FLAKY_REL);
  return existsSync(p) ? parseFlaky(readFileSync(p, 'utf8')) : { accepted: new Map(), noReason: [] };
}

// Pure: from the results of each pass ([{ name: status }, …]) to the verdict.
export function judge(passes, { accepted = new Map(), noReason = [] } = {}) {
  const everFailed = new Set();
  for (const p of passes) for (const [n, s] of Object.entries(p)) if (s === 'fail') everFailed.add(n);
  const last = passes.at(-1) ?? {};
  const failing = [...everFailed].filter((n) => last[n] === 'fail' && passes.every((p) => p[n] === 'fail' || !(n in p)));
  const unsteady = [...everFailed].filter((n) => !failing.includes(n));
  const unaccepted = unsteady.filter((n) => !accepted.has(n));
  return {
    failed_once: [...everFailed].sort(),
    failing: failing.sort(),
    unsteady: unsteady.sort(),
    accepted: unsteady.filter((n) => accepted.has(n)).sort(),
    unaccepted: unaccepted.sort(),
    without_reason: unaccepted.filter((n) => noReason.includes(n)).sort(),
    ok: failing.length === 0 && unaccepted.length === 0,
  };
}

// Runs, records and judges. `run` is injectable for tests; it returns { tests, exit, ran }.
export function testsRun(root, id, { run = runProjectTests, now = new Date() } = {}) {
  const passes = [];
  const first = run(root);
  passes.push(first.tests);
  while (Object.values(passes.at(-1)).includes('fail') && passes.length < MAX_PASSES) passes.push(run(root).tests);
  const verdict = judge(passes, readFlaky(root));
  mkdirSync(join(root, '.analucia', 'evidence', id), { recursive: true });
  const record = { order: id, recorded: now.toISOString(), passes: passes.length, ran: first.ran, ...verdict };
  writeFileSync(join(root, runRel(id)), `${JSON.stringify(record, null, 2)}\n`);
  return { ...record, path: runRel(id) };
}
