// Review of documents by the owner (AMD-0007 §1, ORD-0023 part A).
// An executor registers a document (review.requested, with the LF-normalised sha256 of its bytes); the owner decides in
// "aos sign" (review.decision: approve, comment or reject, with a note). A decision belongs to the content it reviewed:
// when the file changes, the decision stops counting and the document is waiting again. A decision never closes an order.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { hashLF } from './lock.mjs';
import { appendEvent, readLog } from './log.mjs';
import { writeReviewPage } from './markdown.mjs';
import { RuleError, replay } from './state.mjs';

export const REVIEW_DECISIONS = ['approve', 'comment', 'reject'];
const NOTE_REQUIRED = new Set(['comment', 'reject']);

const toPosix = (p) => p.split(sep).join('/');

// A path inside the project, written relative and with forward slashes, the way it is stored in the log.
export function reviewPath(root, path) {
  const abs = isAbsolute(path) ? path : resolve(root, path);
  const rel = toPosix(relative(resolve(root), abs));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new RuleError('E_REVIEW_PATH', `${path} is outside the project; a document for review lives inside it`);
  return rel;
}

export const fileHash = (root, rel) => (existsSync(join(root, rel)) && statSync(join(root, rel)).isFile() ? hashLF(readFileSync(join(root, rel))) : null);

// ORD-0042 part 9 (OBS-153): a document for the owner ends with the fixed section "## Decisiones". Each decision is one
// question followed by its options, one per line ("- A) …", "- B) …"); a document with nothing to decide writes the
// single line "Ninguna". Returns null when the section is right, else one sentence that says what to add.
export const DECISIONS_HEADING = '## Decisiones';
export function decisionsProblem(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^## Decisiones\s*$/.test(l));
  if (start === -1) return `the document has no section "${DECISIONS_HEADING}"; add at the end: ${DECISIONS_HEADING}, then each decision as one question followed by its options ("- A) …", "- B) …"), or the single line Ninguna`;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,2} /.test(l));
  const body = (end === -1 ? rest : rest.slice(0, end)).map((l) => l.trim()).filter(Boolean);
  if (!body.length) return `the section "${DECISIONS_HEADING}" is empty; write each decision as one question followed by its options, or the single line Ninguna`;
  if (body.length === 1 && /^ninguna\.?$/i.test(body[0])) return null;
  const isOption = (l) => /^[-*] [A-Za-z0-9]{1,2}\) \S/.test(l);
  const questions = [];
  let current = null;
  for (const l of body) {
    if (isOption(l)) {
      if (!current) return `the section "${DECISIONS_HEADING}" has an option before any question ("${l}"); write the question on its own line first`;
      current.options += 1;
      if (!questions.includes(current)) questions.push(current);
    } else {
      current = { text: l, options: 0 };
      if (/\?$/.test(l)) questions.push(current);
    }
  }
  if (!questions.length) return `the section "${DECISIONS_HEADING}" has no decision; write each one as a question followed by its options, or the single line Ninguna`;
  const few = questions.find((q) => q.options < 2);
  if (few) return `the decision "${few.text}" has ${few.options} option(s); a decision needs at least two, one per line: "- A) …", "- B) …"`;
  return null;
}
// Documents that are text and can carry the section; a picture or a rendered page is registered as before.
const TEXT_DOC_RE = /\.(md|markdown|txt)$/i;

export function requestReview(root, path, { order, agent, now = new Date() } = {}) {
  if (!order) throw new RuleError('E_MISSING_FIELD', 'a review needs --order ORD-NNNN: the order the document belongs to');
  const rel = reviewPath(root, path);
  const sha256 = fileHash(root, rel);
  if (!sha256) throw new RuleError('E_FILE_MISSING', `${rel} does not exist or is not a file`);
  const { events } = readLog(root);
  if (!replay(events).records[order]) throw new RuleError('E_NO_ORDER', `${order} is not in the event log; a document is reviewed for an admitted order`);
  if (TEXT_DOC_RE.test(rel)) {
    const problem = decisionsProblem(readFileSync(join(root, rel), 'utf8'));
    if (problem) throw new RuleError('E_REVIEW_DECISIONS', `${rel}: ${problem}`);
  }
  appendEvent(root, { type: 'review.requested', actor: 'executor', subject: order, agent, payload: { path: rel, sha256, order } }, { now });
  return { path: rel, sha256, order };
}

// One entry per path, from the log only, plus the current hash of the file on disk.
//   status: waiting (no decision for this content since the last request) | approve | comment | reject | missing
//   correction: the latest event for the path is a comment or reject (the agent has a note to apply)
export function reviewState(root, events = readLog(root).events) {
  const docs = new Map();
  for (const [i, e] of events.entries()) {
    if (e.type !== 'review.requested' && e.type !== 'review.decision') continue;
    const p = e.payload ?? {};
    const d = docs.get(p.path) ?? { path: p.path, order: p.order ?? e.subject, requested: null, decisions: [], last: null };
    if (e.type === 'review.requested') d.requested = { ts: e.ts, sha256: p.sha256, i };
    else d.decisions.push({ ts: e.ts, decision: p.decision, note: p.note ?? '', sha256: p.sha256, actor: e.actor, after: d.requested?.i ?? null });
    d.order = p.order ?? d.order;
    d.last = e.type;
    docs.set(p.path, d);
  }
  return [...docs.values()].sort((a, b) => (a.path < b.path ? -1 : 1)).map((d) => {
    const current = fileHash(root, d.path);
    // Only an owner decision about this exact content, made after the latest request, counts.
    const counting = d.decisions.filter((x) => x.actor === 'owner' && x.sha256 === current && x.after === (d.requested?.i ?? null)).at(-1) ?? null;
    const latest = d.decisions.at(-1) ?? null;
    const status = !current ? 'missing' : counting ? counting.decision : 'waiting';
    const correction = d.last === 'review.decision' && latest && NOTE_REQUIRED.has(latest.decision) ? latest : null;
    return { path: d.path, order: d.order, sha256: current, requested: d.requested && { ts: d.requested.ts, sha256: d.requested.sha256 }, decision: counting, status, correction };
  });
}

export const waitingReviews = (root, events) => reviewState(root, events).filter((d) => d.status === 'waiting');
export const corrections = (root, events) => reviewState(root, events).filter((d) => d.correction);

// A plain-words line for the owner: the first heading is the title, the first sentence of text is the summary.
export function describe(root, rel) {
  const text = readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n');
  const lines = text.split('\n').map((l) => l.trim());
  const title = lines.find((l) => /^#\s/.test(l))?.replace(/^#+\s*/, '') ?? rel.split('/').at(-1);
  const body = lines.find((l) => l && !l.startsWith('#') && !l.startsWith('---') && !/^[-*|>`]/.test(l)) ?? '';
  const summary = body.length > 140 ? `${body.slice(0, 139)}…` : body;
  return { title, summary };
}

export function decideReview(root, rel, { decision, note = '', now = new Date() }) {
  if (!REVIEW_DECISIONS.includes(decision)) throw new RuleError('E_REVIEW_DECISION', `${JSON.stringify(decision)} is not one of: ${REVIEW_DECISIONS.join(', ')}`);
  if (NOTE_REQUIRED.has(decision) && !note.trim()) throw new RuleError('E_REVIEW_DECISION', `"${decision}" needs a note`);
  const doc = reviewState(root).find((d) => d.path === rel);
  if (!doc || doc.status !== 'waiting') throw new RuleError('E_REVIEW_DECISION', `${rel} is not waiting for a review`);
  appendEvent(root, { type: 'review.decision', actor: 'owner', subject: doc.order, payload: { path: rel, decision, note: note.trim(), sha256: doc.sha256, order: doc.order } }, { now });
  return { path: rel, decision, order: doc.order };
}

// The system viewer, so the owner never has to know a path (ORD-0023 A6).
export function openWithSystemViewer(abs) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', abs]] : process.platform === 'darwin' ? ['open', [abs]] : ['xdg-open', [abs]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return true;
  } catch {
    return false;
  }
}

// The review part of "aos sign": for each waiting document, the owner types approve, comment, reject or open
// (an empty answer leaves it for later). Returns the decisions made.
// ORD-0043 part 6: with `order`, only the documents of that order, together under one heading (`aos sign` shows
// them right before the checks of the order); `announce: false` leaves the total line to the caller.
export async function reviewDocuments(root, { t, ask, out, now = new Date(), open = openWithSystemViewer, order = null, announce = true }) {
  const waiting = waitingReviews(root).filter((d) => !order || d.order === order);
  if (!waiting.length) return [];
  if (announce) out(t('review.waiting', { n: waiting.length }));
  if (order) out(t('review.group', { order, n: waiting.length }));
  const made = [];
  for (const d of waiting) {
    const { title, summary } = describe(root, d.path);
    out('');
    out(t('review.doc', { title, order: d.order }));
    out(t('review.path', { path: d.path }));
    if (summary) out(t('review.summary', { summary }));
    for (;;) {
      const answer = (await ask(t('review.choose'))).trim().toLowerCase();
      if (!answer) { out(t('review.skipped')); break; }
      if (answer === 'open') {
        // ORD-0024 part D: a readable page, written in a temporary folder (never in the repository).
        const page = writeReviewPage(readFileSync(join(root, d.path), 'utf8'), { name: d.path, title, meta: `${d.order} · ${d.path}` });
        out(open(page) ? t('review.opened') : t('review.open_failed', { path: page }));
        continue;
      }
      if (!REVIEW_DECISIONS.includes(answer)) { out(t('review.invalid')); continue; }
      let note = '';
      if (answer === 'comment') note = await ask(t('review.ask_note'));
      if (answer === 'reject') note = await ask(t('review.ask_reason'));
      if (NOTE_REQUIRED.has(answer) && !note.trim()) { out(t('review.note_required')); continue; }
      decideReview(root, d.path, { decision: answer, note, now });
      out(t(`review.done.${answer}`));
      made.push({ path: d.path, decision: answer, order: d.order });
      break;
    }
  }
  return made;
}
