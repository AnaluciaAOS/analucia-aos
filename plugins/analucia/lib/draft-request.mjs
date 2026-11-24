// ORD-0047 part 7 (OBS-202, OBS-203, OBS-209): what a draft takes from the owner's request, and what the preflight
// checks about what the draft assumes. Four checks, each returning sentences that say what to change:
//   1. requestProblems   — `ORD-NNNN.request.md` next to the draft: one point per line, each with its answer or "left out: <why>";
//   2. baseProblems      — the key `base:` is the real main (or origin/main), or an ancestor with only director commits after it;
//   3. assumesProblems   — the key `assumes:`: files, commands and services exist on this machine;
//   4. secretAskProblems — the draft never asks the owner to paste, type or send a key, token, password or secret.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const requestPath = (id) => `${id}.request.md`;

// ---------- 1. request vs draft ----------

// A point is a list line: `- <what the owner asked> => <the part of the draft that answers it>`, or
// `- <what he asked> => left out: <why>`. Returns { points: [{ line, text, answer }], problems }.
export function parseRequest(text) {
  const points = [];
  const problems = [];
  text.replace(/\r\n/g, '\n').split('\n').forEach((raw, i) => {
    const m = /^\s*(?:[-*]|\d+[.)])\s+(.*\S)\s*$/.exec(raw);
    if (!m) return;
    const parts = m[1].split(/\s*(?:=>|→)\s*/);
    const answer = parts.length > 1 ? parts.slice(1).join(' => ').trim() : '';
    const leftOut = /^left out\b\s*:?\s*(.*)$/i.exec(answer);
    if (!answer) problems.push(`line ${i + 1}: the point ${JSON.stringify(parts[0])} has no answer: write "=> <the part of the draft that answers it>" or "=> left out: <why>"`);
    else if (leftOut && leftOut[1].trim() === '') problems.push(`line ${i + 1}: "left out" needs its reason ("=> left out: <why>")`);
    points.push({ line: i + 1, text: parts[0], answer });
  });
  return { points, problems };
}

export function requestProblems(requestText, where) {
  if (requestText === null) return [`E_FILE_MISSING ${where}: a draft comes with the owner's request next to it, one point per line and for each the part of the draft that answers it or "left out: <why>": write ${where}`];
  const { points, problems } = parseRequest(requestText);
  const out = problems.map((p) => `E_MISSING_FIELD ${where}: ${p}`);
  if (!points.length) out.push(`E_MISSING_FIELD ${where}: the request file has no point: one list line per point of the owner's request ("- <point> => <part of the draft>")`);
  return out;
}

// ---------- 2. the real base ----------

const git = (root, args) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 15000 });
  return r.status === 0 ? r.stdout.trim() : null;
};
// A director path: the files of the director and of the log. A code commit after the base is not a director commit.
export const DIRECTOR_PATH_RE = /^(\.analucia\/|core\/)/;

export function baseProblems(root, base, where) {
  if (!base) return [];
  const full = git(root, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
  if (!full) return [`E_DRAFT_ASSUMES ${where}: the base ${base} is not a commit of this repository`];
  const tips = [['main', 'refs/heads/main'], ['origin/main', 'refs/remotes/origin/main']]
    .map(([name, ref]) => [name, git(root, ['rev-parse', '--verify', '--quiet', ref])]).filter(([, sha]) => sha);
  const out = [];
  for (const [name, sha] of tips) {
    if (sha === full) continue;
    const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', full, sha], { cwd: root }).status === 0;
    const files = ancestor ? (git(root, ['diff', '--name-only', `${full}..${sha}`]) ?? '').split('\n').filter(Boolean) : [];
    const code = files.filter((f) => !DIRECTOR_PATH_RE.test(f));
    if (!ancestor) out.push(`E_DRAFT_ASSUMES ${where}: the draft was written on ${full.slice(0, 7)}, which is not an ancestor of ${name} (${sha.slice(0, 7)}): write the draft again on the real ${name}`);
    else if (code.length) out.push(`E_DRAFT_ASSUMES ${where}: the draft was written on ${full.slice(0, 7)} but ${name} is at ${sha.slice(0, 7)} and the commits between them change more than director files (${code.slice(0, 3).join(', ')}${code.length > 3 ? ', ...' : ''}): rebase the draft on ${name} and say the new base`);
  }
  return out;
}

// ---------- 3. what the draft assumes ----------

// `assumes:` entries: `command:<name>`, `service:<url>`, `file:<path>`; without a prefix, an http(s) address is a service
// and anything else is a file of the project.
export function parseAssume(entry) {
  const m = /^(file|command|service)\s*:\s*(.+)$/i.exec(entry.trim());
  if (m) return { kind: m[1].toLowerCase(), value: m[2].trim() };
  if (/^https?:\/\//i.test(entry.trim())) return { kind: 'service', value: entry.trim() };
  return { kind: 'file', value: entry.trim() };
}

const knownFolders = () => (process.platform === 'win32'
  ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs'), join(homedir(), 'AppData', 'Roaming', 'npm')]
  : ['/usr/local/bin', '/opt/homebrew/bin', join(homedir(), '.local', 'bin')]).filter(Boolean);

// Whether a command is found on the path or in a known install folder.
export function commandFound(name) {
  if (!/^[\w.+-]+$/.test(name)) return false;
  const r = process.platform === 'win32' ? spawnSync('where', [name], { encoding: 'utf8' }) : spawnSync('sh', ['-c', 'command -v "$1"', 'sh', name], { encoding: 'utf8' });
  if (r.status === 0 && String(r.stdout).trim()) return true;
  return knownFolders().some((d) => ['', '.exe', '.cmd'].some((ext) => existsSync(join(d, `${name}${ext}`)) || existsSync(join(d, name, `${name}${ext}`))));
}

// Whether a service answers: any HTTP answer in five seconds counts, an error of the connection does not.
export function serviceAnswers(url) {
  const code = 'fetch(process.argv[1],{signal:AbortSignal.timeout(5000)}).then(()=>process.exit(0),()=>process.exit(1))';
  return spawnSync(process.execPath, ['-e', code, url], { timeout: 8000 }).status === 0;
}

const COST = {
  file: 'creating it is work the draft does not list: add it to the draft, or write the order that makes it first',
  command: 'installing it changes the machine of the owner, with its download and its time: he decides it, so ask him or write the order that installs it first',
  service: 'starting or configuring it is work outside the draft: say who starts it, or write the order that does',
};

export function assumesProblems(root, list, where, { probeService = serviceAnswers, probeCommand = commandFound } = {}) {
  const out = [];
  for (const entry of list ?? []) {
    const a = parseAssume(String(entry));
    const present = a.kind === 'file' ? existsSync(resolve(root, a.value)) : a.kind === 'command' ? probeCommand(a.value) : probeService(a.value);
    if (!present) out.push(`E_DRAFT_ASSUMES ${where}: the draft assumes the ${a.kind} ${JSON.stringify(a.value)} and it is not there; what putting it there costs: ${COST[a.kind]}`);
  }
  return out;
}

// ---------- 4. no secret pasted ----------

// One list of phrases in five locales (en, es, pt, hi, zh-Hans): a verb that hands a secret to someone ("paste",
// "type", "send") within a few words of the secret itself ("key", "token", "password", "secret").
const PAIRS = [
  /\b(?:paste|type|enter|send|share|provide|give|copy|supply)\b[^.\n]{0,60}\b(?:api[ -]?keys?|keys?|tokens?|passwords?|secrets?|passphrases?)\b/i,
  /\b(?:pega|pegar|pegues|escribe|escribir|teclea|teclear|env[ií]a|enviar|comparte|compartir|entrega|entregar|proporciona|dame|indica)\b[^.\n]{0,60}\b(?:claves?|llaves?|tokens?|contrase[nñ]as?|secretos?)\b/i,
  /\b(?:cole|colar|digite|digitar|envie|enviar|compartilhe|compartilhar|informe|informar|forne[cç]a)\b[^.\n]{0,60}\b(?:chaves?|tokens?|senhas?|segredos?)\b/i,
  /(?:पासवर्ड|टोकन|कुंजी|चाबी|सीक्रेट)[^.\n]{0,60}(?:पेस्ट|टाइप|भेज|दर्ज|साझा|बता)/u,
  /(?:पेस्ट|टाइप|भेज|दर्ज|साझा|बता)[^.\n]{0,60}(?:पासवर्ड|टोकन|कुंजी|चाबी|सीक्रेट)/u,
  /(?:粘贴|输入|发送|提供|告诉|分享)[^。\n]{0,30}(?:密钥|令牌|密码|口令|秘密)/u,
  /(?:密钥|令牌|密码|口令|秘密)[^。\n]{0,30}(?:粘贴|输入|发送|提供|告诉|分享)/u,
];

// The numbers of the lines that ask for a secret.
export function secretAsked(text) {
  return text.split('\n').flatMap((l, i) => (PAIRS.some((re) => re.test(l)) ? [i + 1] : []));
}

export function secretAskProblems(text, where) {
  const lines = secretAsked(text);
  if (!lines.length) return [];
  return [`E_SECRET_PASTED ${where}:${lines[0]}: the text asks the owner to paste, type or send a key, token, password or secret (line${lines.length > 1 ? 's' : ''} ${lines.join(', ')}). Never: tell him to use his own sign-in or the provider's page instead, and let the tool read the value from where it already is`];
}
