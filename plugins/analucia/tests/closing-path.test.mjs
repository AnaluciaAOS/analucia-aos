// ORD-0040 closing test: in a new empty folder, with no help from any chat, does a person reach a signed order using
// only the plugin and clicks? The whole path in one test. The steps of an agent go through the real CLI; the steps
// of the owner (the windows opened by INICIAR and FIRMAR) are the same functions the CLI calls, with the owner's
// answers injected where a terminal is required. After every step, `aos next` must name the step that follows.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LAUNCHERS, launcherFile } from '../lib/launchers.mjs';
import { checkLock } from '../lib/lock.mjs';
import { readLog } from '../lib/log.mjs';
import { onboardingStarted, runInit } from '../lib/onboarding.mjs';
import { sign } from '../lib/sign.mjs';
import { replay } from '../lib/state.mjs';
import { WIZARD, wizard } from '../lib/wizard.mjs';

// The list of project codes lives in Claude Code's configuration folder: a scratch one, never the owner's.
// Test files may share one process, so the test sets it again when it starts.
const CONFIG = mkdtempSync(join(tmpdir(), 'aos-closing-cfg-'));
process.env.CLAUDE_CONFIG_DIR = CONFIG;
const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
delete env.CLAUDE_PROJECT_DIR;
// The agent's shell: a pipe, never a terminal.
const agent = (cwd, args) => spawnSync(process.execPath, [AOS, ...args], { encoding: 'utf8', input: '', env, cwd });
const next = (cwd) => {
  const r = agent(cwd, ['next']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trimEnd().split('\n').length, 1, r.stdout);
  return r.stdout.trimEnd();
};
// The owner in the window a launcher opens: every prompt is answered with the next scripted line.
const window = (answers) => {
  const prompts = [];
  const printed = [];
  return { prompts, printed, isTTY: true, out: (s) => printed.push(s), ask: async (q) => { prompts.push(q); assert.ok(answers.length, `unexpected prompt: ${q}`); return answers.shift(); } };
};
const noProjectAbove = (dir) => {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, '.analucia'))) return false;
    if (dirname(d) === d) return true;
  }
};

test('closing path: empty folder → launchers → init → first draft → placed by the owner → run → signed → closed', async (t) => {
  process.env.CLAUDE_CONFIG_DIR = CONFIG;
  const dir = mkdtempSync(join(tmpdir(), 'aos-closing-'));
  if (!noProjectAbove(dir)) return t.skip('a folder above the temp folder holds .analucia');
  assert.deepEqual(readdirSync(dir), [], 'a new empty folder');
  const steps = [];

  // 1. agent: what comes next in an empty folder — the launchers.
  assert.match(next(dir), /launchers install$/);
  steps.push('agent');

  // 2. agent: write the launchers (files only).
  assert.equal(agent(dir, ['launchers', 'install']).status, 0);
  for (const l of LAUNCHERS) assert.ok(existsSync(join(dir, launcherFile(l.name))), l.name);
  steps.push('agent');

  // 3. owner, click INICIAR: the 15-question wizard (numbers), then CONFIRM. An agent cannot do it.
  assert.ok(next(dir).includes(launcherFile('INICIAR')));
  assert.match(agent(dir, ['init']).stderr, /E_OWNER_TTY/);
  const numbers = WIZARD.map((q) => (q.key === 'github_owner' ? '2' : '1')); // no GitHub account: this folder has no remote
  const w = window([...numbers, '', 'DEMO', '', 'CONFIRM']); // the 15 answers, the summary, the project code, the owner data (none), then CONFIRM
  const startedAt = new Date();
  const { provided } = await wizard(dir, { locale: 'en', ask: w.ask, out: w.out });
  const init = await runInit(dir, { provided, locale: 'en', isTTY: true, ask: w.ask, out: w.out, wizard: true, onConfirmed: () => onboardingStarted(dir, { startedAt }) });
  assert.equal(init.applied, true);
  assert.equal(JSON.parse(readFileSync(join(dir, '.analucia', 'project.json'), 'utf8')).project_code, 'DEMO');
  assert.ok(existsSync(join(dir, '.analucia', 'events.jsonl')) && existsSync(join(dir, '.analucia', 'DIRECTOR.md')));
  assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
  assert.equal(agent(dir, ['check-roles']).status, 0);
  steps.push('click');

  // 4. agent, as director: nothing is pending, so it writes the first order as a draft, with its verify file.
  assert.match(next(dir), /^Nothing is pending\./);
  assert.match(agent(dir, ['drafts']).stdout, /Next free ID: DEMO-0001/);
  mkdirSync(join(dir, '.analucia', 'drafts'), { recursive: true });
  writeFileSync(join(dir, '.analucia', 'drafts', 'DEMO-0001.md'), ['---', 'id: DEMO-0001', 'title: Write the first page', 'kind: build', 'replaces: []', 'created: 2026-11-14', 'budget_max_minutes: 30', 'budget_max_attempts: 2', 'risk: low', 'cost_effect: none', '---', '', '# DEMO-0001', '', 'Write `hello.txt` with one line.', '', '## Business rules', '', '- none', '', '## Acceptance criteria', '', '- [ ] `hello.txt` exists and is not empty.', ''].join('\n'));
  writeFileSync(join(dir, '.analucia', 'drafts', 'DEMO-0001.json'), `${JSON.stringify({ order: 'DEMO-0001', checks: [{ name: 'the page exists', run: 'test -s hello.txt', expect_exit: 0 }, { name: 'the report ends with an outcome', run: "tail -1 .analucia/evidence/DEMO-0001/report.md | grep -q '^OUTCOME: '", expect_exit: 0 }] }, null, 2)}\n`);
  const checked = agent(dir, ['drafts']);
  assert.equal(checked.status, 0, checked.stdout);
  assert.match(checked.stdout, /^DEMO-0001: ready — Write the first page$/m);
  // The agent cannot place it: the protected path is blocked by the hook, and aos sign needs the owner.
  const hook = spawnSync(process.execPath, [AOS, 'hook', 'pre-tool-use'], { encoding: 'utf8', env: { ...env, CLAUDE_PROJECT_DIR: dir }, input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(dir, '.analucia', 'orders', 'DEMO-0001.md'), content: 'x' }, cwd: dir }) });
  assert.equal(hook.status, 2);
  assert.match(agent(dir, ['sign']).stderr, /E_OWNER_TTY/);
  steps.push('agent');

  // 5. owner, click FIRMAR: the draft is shown with its validation; PLACE places it.
  assert.match(next(dir), new RegExp(`double-click ${launcherFile('FIRMAR').replace('.', '\\.')} .*1 draft order\\(s\\) to place \\(DEMO-0001\\)`));
  const place = window(['PLACE']);
  const placed = await sign(dir, { ...place, push: false });
  assert.deepEqual(placed.placed, ['DEMO-0001']);
  assert.match(place.printed.join('\n'), /DEMO-0001: Write the first page — valid, ready to place/);
  assert.deepEqual(checkLock(dir), [], 'director.lock written by the tool');
  steps.push('click');

  // 6. agent, as executor: start, work, evidence, finish.
  assert.match(next(dir), /^Next \(executor\): start DEMO-0001 \(Write the first page\) with: .* run start DEMO-0001$/);
  assert.equal(agent(dir, ['run', 'start', 'DEMO-0001']).status, 0);
  assert.match(next(dir), /^Next \(executor\): run 1 of DEMO-0001 is open\./);
  writeFileSync(join(dir, 'hello.txt'), 'hello\n');
  mkdirSync(join(dir, '.analucia', 'evidence', 'DEMO-0001'), { recursive: true });
  writeFileSync(join(dir, '.analucia', 'evidence', 'DEMO-0001', 'report.md'), '# DEMO-0001 — report of run 1\n\n## Para el dueño\n\nLa página existe.\n\n## Evidencia\n\n1. 1 de 1 archivo escrito.\n2. Sin muestra: se revisó el único archivo.\n3. Decisión: firmar; se puede revertir borrando el archivo.\n\nWork: complete\nOUTCOME: done\n');
  const finished = agent(dir, ['run', 'finish', 'DEMO-0001', '--outcome', 'done', '--evidence', '.analucia/evidence/DEMO-0001/report.md']);
  assert.equal(finished.status, 0, finished.stderr);
  assert.doesNotMatch(finished.stdout, /warning/);
  assert.match(agent(dir, ['close', 'DEMO-0001']).stderr, /E_TRANSITION|E_OWNER_TTY/, 'the executor cannot close');
  steps.push('agent');

  // 7. owner, click FIRMAR: the checks run, CLOSE signs.
  assert.match(next(dir), new RegExp(`double-click ${launcherFile('FIRMAR').replace('.', '\\.')} .*1 finished order\\(s\\) to sign \\(DEMO-0001\\)`));
  const close = window(['CLOSE']);
  const signed = await sign(dir, { ...close, push: false });
  assert.deepEqual(signed.signed, ['DEMO-0001']);
  assert.deepEqual(signed.failed, []);
  steps.push('click');

  // Reached: a signed (closed) order, an intact log, valid files, and nothing pending.
  const events = readLog(dir).events;
  assert.equal(replay(events).orders['DEMO-0001'].state, 'closed');
  assert.ok(events.some((e) => e.type === 'owner.signed' && e.actor === 'owner'));
  assert.equal(agent(dir, ['verify-log']).status, 0);
  assert.equal(agent(dir, ['validate']).status, 0, agent(dir, ['validate']).stdout);
  assert.equal(agent(dir, ['check-roles']).status, 0);
  assert.match(next(dir), /^Nothing is pending\./);
  // 7 steps: 3 clicks by the person, 4 by an agent, none where the person types a command.
  assert.deepEqual(steps, ['agent', 'agent', 'click', 'agent', 'click', 'agent', 'click']);
});
