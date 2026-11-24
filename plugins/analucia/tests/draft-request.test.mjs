// ORD-0047 part 7 (OBS-202, OBS-203, OBS-209): the request file of a draft, the real base, what the draft assumes, no
// secret asked of the owner.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assumesProblems, baseProblems, parseAssume, parseRequest, requestProblems, secretAsked, secretAskProblems } from '../lib/draft-request.mjs';
import { listDrafts } from '../lib/drafts.mjs';
import { logPath } from '../lib/log.mjs';

test('the request file: every point has its answer or a reason it was left out', () => {
  const good = '# Request\n- sell by day => Part 1\n- a mobile app => left out: not this order\n';
  assert.deepEqual(requestProblems(good, 'r.md'), []);
  assert.match(requestProblems(null, 'r.md')[0], /E_FILE_MISSING/);
  const bad = requestProblems('- sell by day\n- an export => left out:\n', 'r.md');
  assert.equal(bad.length, 2);
  assert.match(bad[0], /no answer/);
  assert.match(bad[1], /needs its reason/);
  assert.match(requestProblems('only prose\n', 'r.md')[0], /no point/);
  assert.equal(parseRequest('- a => b\r\n').points[0].answer, 'b');
});

const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd, encoding: 'utf8' });
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'aos-base-'));
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'code.txt'), '1');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'code');
  const sha = () => git(dir, 'rev-parse', 'HEAD').stdout.trim();
  return { dir, sha };
}

test('the base is the real main, or an ancestor with only director commits after it', () => {
  const { dir, sha } = repo();
  const base = sha();
  assert.deepEqual(baseProblems(dir, base, 'd.md'), []);
  mkdirSync(join(dir, '.analucia', 'orders'), { recursive: true });
  writeFileSync(join(dir, '.analucia', 'orders', 'ORD-0001.md'), 'x');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'Director: placed');
  assert.deepEqual(baseProblems(dir, base, 'd.md'), [], 'only a director commit after the base');
  writeFileSync(join(dir, 'code.txt'), '2');
  git(dir, 'commit', '-q', '-am', 'code again');
  const stale = baseProblems(dir, base, 'd.md');
  assert.equal(stale.length, 1);
  assert.match(stale[0], /E_DRAFT_ASSUMES/);
  assert.ok(stale[0].includes(base.slice(0, 7)) && stale[0].includes(sha().slice(0, 7)), 'names both commits');
  assert.match(baseProblems(dir, 'deadbeef', 'd.md')[0], /not a commit/);
  assert.deepEqual(baseProblems(dir, undefined, 'd.md'), []);
});

test('assumes: a file, a command and a service are checked on the machine; what is missing is named with its cost', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aos-assumes-'));
  writeFileSync(join(dir, 'here.txt'), 'x');
  assert.deepEqual(parseAssume('command: psql'), { kind: 'command', value: 'psql' });
  assert.deepEqual(parseAssume('http://localhost:1/x'), { kind: 'service', value: 'http://localhost:1/x' });
  assert.deepEqual(parseAssume('db/a.sql'), { kind: 'file', value: 'db/a.sql' });
  const probes = { probeCommand: (n) => n === 'node', probeService: (u) => u.includes('up') };
  assert.deepEqual(assumesProblems(dir, ['here.txt', 'command:node', 'service:http://up.example'], 'd.md', probes), []);
  const miss = assumesProblems(dir, ['nope.txt', 'command:no-such-tool-0047', 'service:http://down.example'], 'd.md', probes);
  assert.equal(miss.length, 3);
  assert.match(miss[1], /no-such-tool-0047/);
  assert.match(miss[1], /changes the machine of the owner/);
  // the real probes: a command that exists, one that does not, a port nobody listens on
  assert.deepEqual(assumesProblems(dir, [`command:${'node'}`], 'd.md'), []);
  assert.equal(assumesProblems(dir, ['command:no-such-tool-0047', 'service:http://127.0.0.1:9/'], 'd.md').length, 2);
});

test('a draft that asks the owner to paste a key, token, password or secret is refused, in five languages', () => {
  const asks = [
    'Paste the API key here.',
    'Please type your password in the form.',
    'Pega la clave en este archivo.',
    'Envía el token por el chat.',
    'Cole a senha no terminal.',
    'Digite o segredo aqui.',
    'अपना पासवर्ड यहाँ टाइप करें।',
    '请把密钥粘贴到这里。',
  ];
  for (const a of asks) assert.deepEqual(secretAsked(a), [1], a);
  for (const ok of ['Sign in on the provider page.', 'The key figure is 12.', 'Usa tu propio inicio de sesión.', 'Entra na página do provedor.']) assert.deepEqual(secretAsked(ok), [], ok);
  const p = secretAskProblems('fine\nPaste the token here\n', 'd.md');
  assert.match(p[0], /E_SECRET_PASTED d\.md:2/);
  assert.match(p[0], /sign-in|provider's page/);
});

test('aos drafts refuses a draft without its request file or with an unanswered point, and a secret ask', () => {
  const root = mkdtempSync(join(tmpdir(), 'aos-draftreq-'));
  mkdirSync(join(root, '.analucia', 'drafts'), { recursive: true });
  writeFileSync(join(root, '.analucia', 'project.json'), `${JSON.stringify({ wip_limit: 1, locale: 'en' })}\n`);
  writeFileSync(logPath(root), '');
  const order = (extra = '') => `---\nid: ORD-0001\ntitle: One\nkind: fix\ncreated: 2026-11-21\nbudget_max_minutes: 10\nbudget_max_attempts: 1\nrisk: low\ncost_effect: none\nrollback: none\ndepends_on: []\n${extra}---\n\n# One\n\n## Acceptance criteria\n\n- [ ] done\n`;
  const d = join(root, '.analucia', 'drafts');
  writeFileSync(join(d, 'ORD-0001.json'), `${JSON.stringify({ order: 'ORD-0001', checks: [{ name: 'x', run: 'exit 0', expect_exit: 0 }] })}\n`);
  writeFileSync(join(d, 'ORD-0001.md'), order());
  const mine = (list) => list.find((x) => x.id === 'ORD-0001').problems.filter((p) => /request|E_SECRET|E_DRAFT/.test(p));
  assert.ok(mine(listDrafts(root)).some((p) => /E_FILE_MISSING.*request/.test(p)));
  writeFileSync(join(d, 'ORD-0001.request.md'), '- sell by day\n');
  assert.ok(mine(listDrafts(root)).some((p) => /no answer/.test(p)));
  writeFileSync(join(d, 'ORD-0001.request.md'), '- sell by day => the whole order\n');
  assert.deepEqual(mine(listDrafts(root)), []);
  writeFileSync(join(d, 'ORD-0001.md'), `${order()}\nPaste the password here.\n`);
  assert.ok(mine(listDrafts(root)).some((p) => /E_SECRET_PASTED/.test(p)));
  writeFileSync(join(d, 'ORD-0001.md'), order('assumes: [file:missing/thing.sql]\n'));
  assert.ok(mine(listDrafts(root)).some((p) => /E_DRAFT_ASSUMES/.test(p)));
});
