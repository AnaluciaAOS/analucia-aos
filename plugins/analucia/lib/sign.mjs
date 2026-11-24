// One signing command for the owner (AMD-0005 §3): verify what is finished, show it, close what passed after the
// owner types CLOSE, record owner.signed, commit the sign-off and push it through the pre-push guard.
// The typed confirmation at a real terminal stays (E_OWNER_TTY): a file edited by an agent never closes an order.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { aosCommand } from './cli.mjs';
import { listDrafts, placeDrafts } from './drafts.mjs';
import { installLaunchers } from './launchers.mjs';
import { WAIVER_MIN_REASON, close, failedGroups, sendBackForRework, verify, waiveFormChecks } from './lifecycle.mjs';
import { appendEvent, readLog } from './log.mjs';
import { reviewDocuments, waitingReviews } from './review.mjs';
import { projectName } from './owner-status.mjs';
import { LOCALES, catalog } from './onboarding.mjs';
import { gitNetwork } from './git-timeout.mjs';
import { RuleError, replay } from './state.mjs';
import { parseFrontMatter } from './validate.mjs';

// The owner's typed words: the English word as before, and the Spanish one (any case) next to it (ORD-0046 part 7).
const wordIs = (answer, english, spanish) => answer.trim() === english || answer.trim().toUpperCase() === spanish;

const git = (root, args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
// The owner's own pushes (the step to main and the sign-off): the push guard's second lock lets them through (ORD-0043 part 16).
// ORD-0047 part 11: with a time limit and no prompt, so a push never waits for ever.
const ownerPush = (root) => gitNetwork(root, ['push'], { env: { AOS_OWNER_PUSH: '1' } });
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
    if (d.ok) {
      out(t('sign.draft_ok', { id: d.id, title: d.title }));
      if (d.would_get) out(t('drafts.would_get', { would: d.would_get })); // ORD-0047 part 9: not yet given
      // ORD-0042 part 10: the business rules of the draft, with their examples, before the typed confirmation.
      if (d.rules?.length) {
        out(t('sign.draft_rules', { id: d.id, n: d.rules.length }));
        for (const rule of d.rules) out(t('sign.draft_rule', { rule }));
      }
    }
    else {
      out(t('sign.draft_bad', { id: d.id }));
      for (const reason of d.problems) out(t('sign.draft_reason', { reason }));
    }
  }
  const ready = drafts.filter((d) => d.ok).map((d) => d.id);
  const notReady = drafts.filter((d) => !d.ok).map(({ id, problems }) => ({ id, problems }));
  if (!ready.length) return { placed: [], refused: notReady };
  const answer = await ask(t('sign.drafts_confirm', { ids: ready.join(', ') }));
  if (!wordIs(answer, 'PLACE', 'COLOCAR')) {
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
  out(t('sign.project', { project: projectName(root) })); // ORD-0046 part 7: where the owner is, first of all
  const drafts = await placeWaitingDrafts(root, { t, ask, out, now });
  const result = await signOrders(root, { t, ask, out, now, push, open });
  // ORD-0041 part 7 (AMD-0015 §7): at least one order closed on a branch that is not the default branch, and the
  // sign-off pushed: offer the step to the default branch.
  const merged = result.signed?.length && result.pushed ? await offerStepToDefault(root, { t, ask, out }) : undefined;
  return { ...result, placed: drafts.placed, not_placed: drafts.refused, ...(merged ? { merged } : {}) };
}

// ORD-0043 part 2: the waiver, offered only here (the caller already checked that this is the owner's terminal) and
// only when every failed check of the order is of class form. Each one is shown with its name, its command and its
// exit code, and needs the typed word WAIVE and a written reason of at least ten characters. One check not waived:
// nothing is waived (null).
async function offerWaiver(root, id, { t, ask, out, results, names }) {
  let commands = new Map();
  try {
    commands = new Map(JSON.parse(readFileSync(join(root, '.analucia', 'verify', `${id}.json`), 'utf8')).checks.map((c) => [c.name, c.run]));
  } catch { /* the verify file was read by aos verify a moment ago; without it the command is not shown */ }
  out(t('sign.waive_title', { id, n: names.length }));
  const list = [];
  for (const name of names) {
    const r = results.find((c) => c.name === name && !c.passed);
    out(t('sign.waive_check', { name, run: commands.get(name) ?? '?', exit: r.exit, expected: r.expect_exit }));
    if ((await ask(t('sign.waive_word', { name }))).trim() !== 'WAIVE') return null;
    const reason = (await ask(t('sign.waive_reason', { min: WAIVER_MIN_REASON }))).trim();
    if (reason.length < WAIVER_MIN_REASON) {
      out(t('sign.waive_short', { min: WAIVER_MIN_REASON }));
      return null;
    }
    list.push({ check: name, reason });
  }
  return list;
}

async function signOrders(root, { t, ask, out, now, push, open }) {
  // AMD-0007 §1: documents waiting for the owner's review come first; a decision is not a close.
  // ORD-0043 part 6: one gate per order. The reviews of one order are shown together, right before its checks; the
  // documents of an order that is not delivered yet come first, one order at a time.
  const orders = replay(readLog(root).events).orders;
  const waitingDocs = waitingReviews(root);
  if (waitingDocs.length) out(t('review.waiting', { n: waitingDocs.length }));
  const reviewed = [];
  const reviewOf = async (id) => {
    const made = await reviewDocuments(root, { t, ask, out, now, order: id, announce: false, ...(open ? { open } : {}) });
    reviewed.push(...made);
    return made;
  };
  // ORD-0046 part 7 (OBS-195): the orders he came for come first (drafts, then the delivered and verified orders, each
  // with its own documents right before its checks). Documents of other open orders follow; the documents of orders
  // already closed come last, under a heading that says so. A document changed by another order belongs to that order.
  const docOrder = (d) => d.shownIn ?? d.order;
  const isOpenOrder = (id) => orders[id] && !['closed', 'rejected', 'superseded', 'cancelled'].includes(orders[id].state);
  const restOfDocuments = async () => {
    const left = (docs) => docs.filter((d) => !reviewed.some((r) => r.path === d.path));
    for (const id of [...new Set(left(waitingReviews(root)).map(docOrder))].filter((o) => isOpenOrder(o) && !['delivered', 'verified'].includes(orders[o]?.state)).sort()) await reviewOf(id);
    const closedDocs = left(waitingReviews(root));
    if (closedDocs.length) {
      const made = await reviewDocuments(root, { t, ask, out, now, announce: false, docs: closedDocs, heading: t('review.closed_group', { n: closedDocs.length }), ...(open ? { open } : {}) });
      reviewed.push(...made);
    }
  };
  const reworked = [];
  // ORD-0043 part 4: a blocked order is not offered for signature; one line says what it waits for and the command
  // that takes it out (part 3).
  for (const id of Object.keys(orders).filter((o) => orders[o].state === 'blocked').sort()) {
    out(t('sign.blocked', { id, by: orders[id].reason ?? orders[id].blocked_by ?? '-', cmd: `${aosCommand()} resume-order ${id} --reason "<why the block has ended>"` }));
  }
  const delivered = Object.keys(orders).filter((id) => orders[id].state === 'delivered').sort();
  const alreadyVerified = Object.keys(orders).filter((id) => orders[id].state === 'verified').sort();
  if (!delivered.length && !alreadyVerified.length) {
    out(t('sign.none'));
    await restOfDocuments();
    return reviewed.length ? commitSignOff(root, { t, out, push, closed: [], failed: [], reviewed }) : { signed: [], failed: [], reviewed };
  }
  const passed = [];
  const failed = [];
  const waivers = new Map(); // ORD-0043 part 2: order → the checks of form the owner waived, written only after CLOSE
  for (const id of delivered) {
    // ORD-0043 part 6: one decision of corrections (comment or reject) sends this order back for rework, with the
    // transition delivered -> active that exists; its checks are not run and the other orders are not touched.
    const corrections = (await reviewOf(id)).filter((d) => d.decision !== 'approve');
    if (corrections.length) {
      try {
        sendBackForRework(root, id, { documents: corrections.length, isTTY: true, now });
        out(t('sign.rework', { id, n: corrections.length }));
        reworked.push(id);
      } catch (x) {
        if (!x.code) throw x;
        out(t('sign.rework_held', { id, n: corrections.length, why: x.code }));
      }
      continue;
    }
    out(t('sign.checking', { id, title: titleOf(root, id) }));
    const onCheck = (c) => out(c.passed ? t(c.passed_on_second_run ? 'sign.check_pass_second' : 'sign.check_pass', { name: c.name }) : t('sign.check_fail', { name: c.name, exit: c.exit, expected: c.expect_exit }));
    try {
      const r = verify(root, id, { onCheck });
      out(t('sign.evidence', { path: r.evidence }));
      out(t('sign.ready', { id }));
      passed.push(id);
    } catch (x) {
      if (!x.code) throw x;
      if (x.evidence) out(t('sign.evidence', { path: x.evidence }));
      // ORD-0043 part 2: every failed check is of class form → the owner may waive each one with a written reason.
      const groups = x.code === 'E_VERIFY_FAILED' ? failedGroups(x.results ?? []) : null;
      if (groups && groups.form.length && !groups.substance.length) {
        const waived = await offerWaiver(root, id, { t, ask, out, results: x.results, names: groups.form });
        if (waived) {
          waivers.set(id, waived);
          out(t('sign.waived', { id, n: waived.length }));
          passed.push(id);
          continue;
        }
        out(t('sign.waive_none', { id }));
      }
      const why = !groups ? x.code : groups.form.length ? `substance: ${groups.substance.join(', ') || '-'}; form: ${groups.form.join(', ')}` : groups.substance.join(', ');
      out(t('sign.failed', { id, why }));
      failed.push(id);
    }
  }
  for (const id of alreadyVerified) {
    await reviewOf(id);
    out(t('sign.checking', { id, title: titleOf(root, id) }));
    const ev = orders[id].evidence.filter((e) => e.level === 'verified').at(-1);
    if (ev?.path) out(t('sign.evidence', { path: ev.path }));
    out(t('sign.already', { id }));
    passed.push(id);
  }
  await restOfDocuments();
  if (!passed.length) {
    if (failed.length || !reworked.length) out(t('sign.nothing_passed'));
    return reviewed.length ? commitSignOff(root, { t, out, push, closed: [], failed, reviewed }) : { signed: [], failed, reviewed };
  }
  const answer = await ask(t('sign.confirm', { ids: passed.join(', ') }));
  if (!wordIs(answer, 'CLOSE', 'CERRAR')) {
    // The review decisions already made are kept and committed; no order is closed.
    if (reviewed.length) commitSignOff(root, { t, out, push, closed: [], failed, reviewed });
    throw new RuleError('E_NOT_CONFIRMED', t('sign.not_confirmed'));
  }
  // The owner typed CLOSE at a terminal: the same owner-only close as "aos close", without asking twice.
  // ORD-0043 part 2: the waivers are written now, after the owner's CLOSE: into the verify evidence (WAIVED) and
  // then into the payload of the sign-off event; the order goes on as one whose checks all passed.
  const waived = [];
  for (const [id, list] of waivers) waived.push(...waiveFormChecks(root, id, { waivers: list, isTTY: true, now }));
  await close(root, passed, { isTTY: true, ask: async () => 'CLOSE', now });
  appendEvent(root, { type: 'owner.signed', actor: 'owner', subject: null, payload: { orders: passed, failed, ...(waived.length ? { waived } : {}) } }, { now });
  out(t('sign.closed', { ids: passed.join(', ') }));
  return commitSignOff(root, { t, out, push, closed: passed, failed, reviewed });
}

// The default branch of the repository: what origin/HEAD names, else main, else master. Null when none exists.
function defaultBranch(root) {
  const head = git(root, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']).stdout.trim();
  if (head.startsWith('origin/')) return head.slice('origin/'.length);
  for (const b of ['main', 'master']) if (git(root, ['rev-parse', '--verify', '-q', `refs/heads/${b}`]).status === 0) return b;
  return null;
}

// ORD-0041 part 7 (AMD-0015 §7): the step to the default branch, after a signature on another branch. It shows the
// branch, the number of commits and that it is a fast-forward, and asks for the typed word MERGE. On that word:
// switch, merge --ff-only, push (through the pre-push guard). If a fast-forward is not possible, or a step fails,
// nothing further changes and one line says so. Never a force, never a merge commit. The caller already checked
// that this is the owner's terminal. Returns undefined when there is nothing to offer (already on the default branch).
async function offerStepToDefault(root, { t, ask, out }) {
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  const into = defaultBranch(root);
  if (!into || !branch || branch === 'HEAD' || branch === into) return undefined;
  gitNetwork(root, ['fetch', '-q', 'origin', into]); // what the remote has now; without a network the local knowledge is used
  const commits = Number(git(root, ['rev-list', '--count', `refs/heads/${into}..HEAD`]).stdout.trim() || 0);
  const result = { offered: false, done: false, branch, into, commits };
  const contains = (ref) => git(root, ['rev-parse', '--verify', '-q', ref]).status !== 0 || git(root, ['merge-base', '--is-ancestor', ref, 'HEAD']).status === 0;
  if (!contains(`refs/heads/${into}`) || !contains(`refs/remotes/origin/${into}`)) {
    out(t('sign.merge_not_ff', { branch, into }));
    return result;
  }
  result.offered = true;
  const answer = await ask(t('sign.merge_offer', { branch, into, n: commits }));
  if (!wordIs(answer, 'MERGE', 'UNIR')) {
    out(t('sign.merge_skipped', { into, branch }));
    return result;
  }
  const failed = (step, r) => { out(t('sign.merge_failed', { into, step, why: whyRefused(r) })); return result; };
  const sw = git(root, ['switch', '-q', into]);
  if (sw.status !== 0) return failed('git switch', sw);
  const ff = git(root, ['merge', '-q', '--ff-only', branch]);
  if (ff.status !== 0) {
    git(root, ['switch', '-q', branch]); // back where the owner was; the default branch did not move
    return failed('git merge --ff-only', ff);
  }
  const p = ownerPush(root);
  if (p.status !== 0) {
    out(t('sign.merge_unpushed', { into, why: whyRefused(p) }));
    return result;
  }
  out(t('sign.merge_done', { into, commit: git(root, ['rev-parse', '--short', 'HEAD']).stdout.trim() }));
  return { ...result, done: true };
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
  const p = ownerPush(root);
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
