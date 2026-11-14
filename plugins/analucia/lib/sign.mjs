// One signing command for the owner (AMD-0005 §3): verify what is finished, show it, close what passed after the
// owner types CLOSE, record owner.signed, commit the sign-off and push it through the pre-push guard.
// The typed confirmation at a real terminal stays (E_OWNER_TTY): a file edited by an agent never closes an order.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listDrafts, placeDrafts } from './drafts.mjs';
import { installLaunchers } from './launchers.mjs';
import { close, verify } from './lifecycle.mjs';
import { appendEvent, readLog } from './log.mjs';
import { reviewDocuments } from './review.mjs';
import { LOCALES, catalog } from './onboarding.mjs';
import { RuleError, replay } from './state.mjs';
import { parseFrontMatter } from './validate.mjs';

const git = (root, args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
const localeOf = (root) => {
  try {
    const l = JSON.parse(readFileSync(join(root, '.analucia', 'project.json'), 'utf8')).locale;
    return LOCALES.includes(l) ? l : 'en';
  } catch {
    return 'en';
  }
};
const titleOf = (root, id) => {
  const p = join(root, '.analucia', 'orders', `${id}.md`);
  return existsSync(p) ? parseFrontMatter(readFileSync(p, 'utf8')).fields.get('title')?.value ?? '' : '';
};

// One line that says why git refused, never more (AMD-0005 §3).
const whyRefused = (r) => {
  const lines = `${r.stderr ?? ''}\n${r.stdout ?? ''}`.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /\bE_[A-Z_]+\b/.test(l)) ?? lines.find((l) => /rejected|denied|error|fatal/i.test(l)) ?? lines.at(-1) ?? `exit ${r.status}`;
};

// ORD-0040 part 2: the drafts waiting come first. Each one is shown with the result of validating it; the valid
// ones are placed only after the owner types PLACE at the terminal: copied to the protected paths, hashed into
// director.lock and admitted by the tool itself. Anything else typed leaves them as drafts.
async function placeWaitingDrafts(root, { t, ask, out, now }) {
  const drafts = listDrafts(root);
  if (!drafts.length) return { placed: [], refused: [] };
  out(t('sign.drafts_title', { n: drafts.length }));
  for (const d of drafts) {
    if (d.ok) out(t('sign.draft_ok', { id: d.id, title: d.title }));
    else {
      out(t('sign.draft_bad', { id: d.id }));
      for (const reason of d.problems) out(t('sign.draft_reason', { reason }));
    }
  }
  const ready = drafts.filter((d) => d.ok).map((d) => d.id);
  const notReady = drafts.filter((d) => !d.ok).map(({ id, problems }) => ({ id, problems }));
  if (!ready.length) return { placed: [], refused: notReady };
  const answer = await ask(t('sign.drafts_confirm', { ids: ready.join(', ') }));
  if (answer.trim() !== 'PLACE') {
    out(t('sign.drafts_skipped'));
    return { placed: [], refused: notReady };
  }
  const r = placeDrafts(root, { ids: ready, now });
  for (const x of r.refused) out(t('sign.drafts_refused', { id: x.id, why: x.problems.join('; ') }));
  if (r.placed.length) {
    out(t('sign.drafts_placed', { ids: r.placed.join(', ') }));
    // Director paths and the log only (SPEC-0004 §4): the placement needs no order trailer.
    if (git(root, ['rev-parse', '--is-inside-work-tree']).stdout.trim() === 'true') {
      // Only these paths are committed, whatever else is staged in the project.
      const paths = ['.analucia/events.jsonl', '.analucia/director.lock', ...r.placed.flatMap((id) => [`.analucia/orders/${id}.md`, `.analucia/verify/${id}.json`])];
      git(root, ['add', '--', ...paths]);
      const c = spawnSync('git', ['-C', root, 'commit', '-q', '-F', '-', '--', ...paths], { input: `Director: ${r.placed.join(', ')} placed (owner confirmed, aos sign)\n`, encoding: 'utf8' });
      if (c.status === 0) out(t('sign.drafts_committed', { commit: git(root, ['rev-parse', '--short', 'HEAD']).stdout.trim() }));
    }
  }
  return { placed: r.placed, refused: [...notReady, ...r.refused] };
}

export async function sign(root, { isTTY, ask, out = () => {}, now = new Date(), push = true, open } = {}) {
  if (!isTTY) throw new RuleError('E_OWNER_TTY', 'signing needs the owner at an interactive terminal; stdin is not a TTY (agents cannot sign). The owner double-clicks FIRMAR or runs "aos sign" in their own terminal');
  const t = catalog(localeOf(root));
  const drafts = await placeWaitingDrafts(root, { t, ask, out, now });
  const result = await signOrders(root, { t, ask, out, now, push, open });
  return { ...result, placed: drafts.placed, not_placed: drafts.refused };
}

async function signOrders(root, { t, ask, out, now, push, open }) {
  // AMD-0007 §1: documents waiting for the owner's review come first; a decision is not a close.
  const reviewed = await reviewDocuments(root, { t, ask, out, now, ...(open ? { open } : {}) });
  const orders = replay(readLog(root).events).orders;
  const delivered = Object.keys(orders).filter((id) => orders[id].state === 'delivered').sort();
  const alreadyVerified = Object.keys(orders).filter((id) => orders[id].state === 'verified').sort();
  if (!delivered.length && !alreadyVerified.length) {
    out(t('sign.none'));
    return reviewed.length ? commitSignOff(root, { t, out, push, closed: [], failed: [], reviewed }) : { signed: [], failed: [], reviewed };
  }
  const passed = [];
  const failed = [];
  for (const id of delivered) {
    out(t('sign.checking', { id, title: titleOf(root, id) }));
    const onCheck = (c) => out(c.passed ? t('sign.check_pass', { name: c.name }) : t('sign.check_fail', { name: c.name, exit: c.exit, expected: c.expect_exit }));
    try {
      const r = verify(root, id, { onCheck });
      out(t('sign.evidence', { path: r.evidence }));
      out(t('sign.ready', { id }));
      passed.push(id);
    } catch (x) {
      if (!x.code) throw x;
      if (x.evidence) out(t('sign.evidence', { path: x.evidence }));
      const why = x.code === 'E_VERIFY_FAILED' ? (x.results ?? []).filter((c) => !c.passed).map((c) => c.name).join(', ') : x.code;
      out(t('sign.failed', { id, why }));
      failed.push(id);
    }
  }
  for (const id of alreadyVerified) {
    out(t('sign.checking', { id, title: titleOf(root, id) }));
    const ev = orders[id].evidence.filter((e) => e.level === 'verified').at(-1);
    if (ev?.path) out(t('sign.evidence', { path: ev.path }));
    out(t('sign.already', { id }));
    passed.push(id);
  }
  if (!passed.length) {
    out(t('sign.nothing_passed'));
    return reviewed.length ? commitSignOff(root, { t, out, push, closed: [], failed, reviewed }) : { signed: [], failed, reviewed };
  }
  const answer = await ask(t('sign.confirm', { ids: passed.join(', ') }));
  if (answer.trim() !== 'CLOSE') {
    // The review decisions already made are kept and committed; no order is closed.
    if (reviewed.length) commitSignOff(root, { t, out, push, closed: [], failed, reviewed });
    throw new RuleError('E_NOT_CONFIRMED', t('sign.not_confirmed'));
  }
  // The owner typed CLOSE at a terminal: the same owner-only close as "aos close", without asking twice.
  await close(root, passed, { isTTY: true, ask: async () => 'CLOSE', now });
  appendEvent(root, { type: 'owner.signed', actor: 'owner', subject: null, payload: { orders: passed, failed } }, { now });
  out(t('sign.closed', { ids: passed.join(', ') }));
  return commitSignOff(root, { t, out, push, closed: passed, failed, reviewed });
}

// Commit only the sign-off files (the log and the evidence: owner and director paths, SPEC-0004 §4) and push.
function commitSignOff(root, { t, out, push, closed, failed, reviewed }) {
  const result = { signed: closed, failed, reviewed, committed: false, pushed: false };
  if (git(root, ['rev-parse', '--is-inside-work-tree']).stdout.trim() !== 'true') {
    out(t('sign.no_git'));
    return result;
  }
  git(root, ['add', '--', '.analucia/events.jsonl', '.analucia/evidence']);
  const reviewedOrders = [...new Set(reviewed.map((r) => r.order))].filter((id) => !closed.includes(id));
  const subject = closed.length
    ? `Sign-off: close ${closed.join(', ')}${reviewed.length ? ` and ${reviewed.length} review decision(s)` : ''} (owner, aos sign)`
    : `Sign-off: ${reviewed.length} review decision(s) (owner, aos sign)`;
  const message = [subject, '', ...[...closed, ...reviewedOrders].map((id) => `Analucia-Order: ${id}`)].join('\n');
  const c = spawnSync('git', ['-C', root, 'commit', '-q', '-F', '-'], { input: `${message}\n`, encoding: 'utf8' });
  if (c.status !== 0) {
    out(t('sign.push_refused', { why: whyRefused(c) }));
    return result;
  }
  const commit = git(root, ['rev-parse', '--short', 'HEAD']).stdout.trim();
  out(t('sign.committed', { commit }));
  Object.assign(result, { committed: true, commit });
  if (!push) return result;
  const p = git(root, ['push']);
  if (p.status !== 0) {
    out(t('sign.push_refused', { why: whyRefused(p) }));
    return result;
  }
  out(t('sign.pushed'));
  return { ...result, pushed: true };
}

// aos sign --install-launcher (AMD-0005 §3) keeps working: it writes FIRMAR alone, from the one launcher template
// of lib/launchers.mjs (ORD-0040 part 4).
export function installLauncher(root, { out = () => {} } = {}) {
  const t = catalog(localeOf(root));
  const written = installLaunchers(root, { only: ['FIRMAR'], locale: localeOf(root) });
  for (const { file, status } of written) out(t('sign.launcher', { file, status: t(`status.${status}`) }));
  return written.map(({ file, status }) => ({ file, status }));
}
