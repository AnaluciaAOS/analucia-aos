// ORD-0047 part 3 (OBS-205): "not worse than before". An order closed with a test in red that it had not touched and the
// next order inherited it. `aos tests baseline <ID>` runs the tests of the project (project.json `tests`) on the untouched
// tree and records every test and whether it passed; `aos tests compare <ID>` runs them again and fails on any test that
// passed in the baseline and fails now, wherever it is. A test that already failed is listed apart and does not fail it.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readProject } from './cost.mjs';

const evidenceDir = (root, id) => join(root, '.analucia', 'evidence', id);
export const baselineRel = (id) => `.analucia/evidence/${id}/tests-baseline.json`;

// The tests of a TAP stream: { name: 'pass' | 'fail' | 'skip' }. Subtests are named by their path ("a > b").
export function parseTap(text) {
  const out = {};
  const stack = []; // [{ indent, name }]
  for (const raw of String(text).replace(/\r\n/g, '\n').split('\n')) {
    const sub = /^(\s*)# Subtest: (.*)$/.exec(raw);
    if (sub) {
      while (stack.length && stack.at(-1).indent >= sub[1].length) stack.pop();
      stack.push({ indent: sub[1].length, name: sub[2].trim() });
      continue;
    }
    const ok = /^(\s*)(not ok|ok) \d+ - (.*?)(?:\s+#\s*(SKIP|TODO)\b.*)?$/.exec(raw);
    if (!ok) continue;
    const indent = ok[1].length;
    while (stack.length && stack.at(-1).indent > indent) stack.pop();
    const parents = stack.filter((s) => s.indent < indent).map((s) => s.name);
    let name = [...parents, ok[3].trim()].join(' > ');
    for (let n = 2; name in out; n++) name = `${[...parents, ok[3].trim()].join(' > ')} #${n}`;
    out[name] = ok[4] ? 'skip' : ok[2] === 'ok' ? 'pass' : 'fail';
  }
  return out;
}

const unxml = (s) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[e]);
// The tests of a JUnit file: { "classname > name": 'pass' | 'fail' | 'skip' }.
export function parseJunit(xml) {
  const out = {};
  for (const m of String(xml).matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attr = (k) => unxml(new RegExp(`\\b${k}="([^"]*)"`).exec(m[1])?.[1] ?? '');
    const cls = attr('classname');
    let name = cls ? `${cls} > ${attr('name')}` : attr('name');
    for (let n = 2; name in out; n++) name = `${cls ? `${cls} > ` : ''}${attr('name')} #${n}`;
    const inner = m[3] ?? '';
    out[name] = /<(failure|error)\b/.test(inner) ? 'fail' : /<skipped\b/.test(inner) ? 'skip' : 'pass';
  }
  return out;
}

// Runs the tests of the project. { tests: { name: status }, exit, ran } or throws an Error with a sentence.
export function runProjectTests(root) {
  const cfg = readProject(root)?.tests;
  if (!cfg) throw Object.assign(new Error('project.json has no "tests" key: { "command": "…", "report": "tap" | "junit:<path>" }'), { code: 'E_FIELD_TYPE' });
  const r = spawnSync(cfg.command, { cwd: root, shell: true, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 30 * 60000 });
  let tests;
  if (cfg.report === 'tap') tests = parseTap(r.stdout ?? '');
  else {
    const file = join(root, cfg.report.slice('junit:'.length));
    if (!existsSync(file)) throw new Error(`the command did not write ${cfg.report.slice('junit:'.length)}`);
    tests = parseJunit(readFileSync(file, 'utf8'));
  }
  if (!Object.keys(tests).length) throw new Error(`the command wrote no test result in the ${cfg.report.split(':')[0]} format (exit ${r.status ?? 'none'}): ${`${r.stderr ?? ''}`.trim().split('\n').slice(-3).join(' ')}`);
  return { tests, exit: r.status, ran: Object.keys(tests).length };
}

// Records the baseline. Returns { path, ran, failing }.
export function testsBaseline(root, id, { now = new Date() } = {}) {
  const run = runProjectTests(root);
  mkdirSync(evidenceDir(root, id), { recursive: true });
  writeFileSync(join(root, baselineRel(id)), `${JSON.stringify({ order: id, recorded: now.toISOString(), tests: run.tests }, null, 2)}\n`);
  return { path: baselineRel(id), ran: run.ran, failing: Object.entries(run.tests).filter(([, s]) => s === 'fail').map(([n]) => n) };
}

// Pure comparison: what passed before and fails now, what failed before, what is gone.
export function compareTests(before, now) {
  const worse = [];
  const alreadyFailing = [];
  const missing = [];
  for (const [name, status] of Object.entries(before)) {
    if (status === 'fail') alreadyFailing.push(name);
    else if (status === 'pass') {
      if (!(name in now)) missing.push(name);
      else if (now[name] === 'fail') worse.push(name);
    }
  }
  return { worse, alreadyFailing, missing };
}

export function testsCompare(root, id) {
  const file = join(root, baselineRel(id));
  if (!existsSync(file)) throw new Error(`there is no baseline: run "aos tests baseline ${id}" on the untouched tree first (${baselineRel(id)})`);
  const before = JSON.parse(readFileSync(file, 'utf8')).tests;
  const run = runProjectTests(root);
  return { ...compareTests(before, run.tests), ran: run.ran, was: Object.keys(before).length };
}
