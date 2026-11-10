// Deterministic evaluations of the mechanisms (ORD-0012): scenarios run the real `aos` commands in temporary
// projects, with no model calls and no cost. They measure the mechanisms, not the AI.
// A scenario is plugins/analucia/tests/evals/<name>.eval.mjs exporting
//   { name, description, expect: [{ exit, code? }], run: async (sb) => [{ status, stdout, stderr }] }
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hashLF } from './lock.mjs';
import { appendEvent, logPath } from './log.mjs';

const AOS = fileURLToPath(new URL('../bin/aos.mjs', import.meta.url));
export const EVALS_DIR = fileURLToPath(new URL('../tests/evals/', import.meta.url));

const env = () => {
  const e = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  delete e.CLAUDE_PROJECT_DIR;
  return e;
};

// The sandbox a scenario works in: temporary projects and the real CLI.
export const sandbox = {
  aos: (root, args, input = '') => spawnSync(process.execPath, [AOS, ...args, '--root', root], { encoding: 'utf8', input, env: env() }),
  git: (root, ...args) => spawnSync('git', ['-C', root, '-c', 'user.name=eval', '-c', 'user.email=eval@example.com', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8', env: env() }),
  write: (root, rel, text) => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
  },
  read: (root, rel) => readFileSync(join(root, rel), 'utf8'),
  // A project with orders (keys: front-matter lines), verify files and a director lock over them.
  project({ orders = [], pinned = false, github = false } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'aos-eval-'));
    for (const d of ['orders', 'verify', 'evidence', 'rollback']) mkdirSync(join(root, '.analucia', d), { recursive: true });
    mkdirSync(join(root, 'core'));
    writeFileSync(join(root, 'core', 'SPEC-0003-X.md'), '---\nid: SPEC-0003\nversion: 0.1.0\n---\n');
    writeFileSync(join(root, '.analucia', 'project.json'), `${JSON.stringify({ wip_limit: 1, github_owner: 'example' })}\n`);
    writeFileSync(logPath(root), '');
    writeFileSync(join(root, '.analucia', 'evidence', 'report.md'), 'evidence\n');
    const files = {};
    for (const o of orders) {
      const text = ['---', `id: ${o.id}`, 'title: Eval order', 'kind: fix', 'created: 2026-10-22', 'budget_max_minutes: 30', 'budget_max_attempts: 2', ...(o.keys ?? []), '---', '', '## Acceptance criteria', '', '- [ ] x', ''].join('\n');
      writeFileSync(join(root, '.analucia', 'orders', `${o.id}.md`), text);
      writeFileSync(join(root, '.analucia', 'verify', `${o.id}.json`), `${JSON.stringify({ order: o.id, checks: [{ name: 'ok', run: 'exit 0', expect_exit: 0 }] })}\n`);
      for (const rel of [`.analucia/orders/${o.id}.md`, `.analucia/verify/${o.id}.json`]) files[rel] = hashLF(readFileSync(join(root, rel)));
    }
    if (orders.length) writeFileSync(join(root, '.analucia', 'director.lock'), `${JSON.stringify({ files }, null, 2)}\n`);
    for (const o of orders) {
      if (pinned) appendEvent(root, { type: 'record.created', actor: 'director', subject: o.id, payload: { pins: { plugin: '0.1.0', specs: { 'SPEC-0003': '0.1.0' } } } });
      else appendEvent(root, { type: 'record.created', actor: 'director', subject: o.id });
      appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: o.id, payload: { from: 'draft', to: 'ready' } });
      appendEvent(root, { type: 'order.state_changed', actor: 'director', subject: o.id, payload: { from: 'ready', to: 'queued' } });
    }
    if (github) {
      const bare = mkdtempSync(join(tmpdir(), 'aos-eval-bare-'));
      sandbox.git(bare, 'init', '-q', '--bare');
      sandbox.git(root, 'init', '-q', '-b', 'main');
      sandbox.git(root, 'add', '-A');
      sandbox.git(root, 'commit', '-q', '-m', 'base');
      sandbox.git(root, 'remote', 'add', 'origin', bare);
      sandbox.git(root, 'push', '-q', '--no-verify', 'origin', 'main');
      sandbox.git(root, 'fetch', '-q', 'origin');
      sandbox.git(root, 'config', 'credential.https://github.com.username', 'example');
    }
    return root;
  },
  // Run an order to `delivered` (and optionally `verified`).
  deliver(root, id, { verify = false } = {}) {
    sandbox.aos(root, ['run', 'start', id]);
    sandbox.aos(root, ['run', 'finish', id, '--outcome', 'done', '--evidence', '.analucia/evidence/report.md']);
    if (verify) sandbox.aos(root, ['verify', id]);
  },
};

const codeOf = (r) => /(?:^|: )(E_[A-Z_]+) /m.exec(`${r.stderr ?? ''}\n${r.stdout ?? ''}`)?.[1] ?? null;

export async function loadScenarios(dir = EVALS_DIR) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.eval.mjs')).sort();
  return Promise.all(files.map(async (f) => ({ file: f, ...(await import(pathToFileURL(join(dir, f)).href)).default })));
}

// Run every scenario; a scenario passes when each step has the expected exit code (and error code, if given).
export async function runEvals({ dir } = {}) {
  const results = [];
  for (const s of await loadScenarios(dir)) {
    let steps = [];
    let error = null;
    try {
      steps = await s.run(sandbox);
    } catch (x) {
      error = x.message;
    }
    const checks = s.expect.map((e, i) => {
      const r = steps[i];
      const got = r ? { exit: r.status, code: codeOf(r) } : { exit: null, code: null };
      return { expect: e, got, ok: Boolean(r) && got.exit === e.exit && (!e.code || got.code === e.code) };
    });
    results.push({ name: s.name, description: s.description, passed: !error && checks.length === steps.length && checks.every((c) => c.ok), checks, error });
  }
  return results;
}

export function evalsReport(results, ts) {
  const passed = results.filter((r) => r.passed).length;
  const out = [`# aos eval run — ${ts}`, '', 'Deterministic scenarios: real `aos` commands in temporary projects, no model calls, no cost.', ''];
  for (const r of results) {
    out.push(`${r.passed ? 'PASS' : 'FAIL'} ${r.name} — ${r.description}`);
    for (const c of r.checks) out.push(`  expected exit ${c.expect.exit}${c.expect.code ? ` ${c.expect.code}` : ''}; got exit ${c.got.exit}${c.got.code ? ` ${c.got.code}` : ''}`);
    if (r.error) out.push(`  error: ${r.error}`);
  }
  out.push('', `total: ${passed} of ${results.length} passed`);
  return out.join('\n');
}
