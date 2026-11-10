// ORD-0029 C: the onboarding wizard. 15 closed questions in 3 blocks of 5 (Security, Operation, Environment), numbered
// options, "Question N of 15" with a progress line per block, 0 to go back, a summary to review before anything is
// applied, and one language field (owner_locale) that sets the language of every text after it, the plan and the
// CONFIRM prompt included. It only collects answers: runInit still shows the plan and the owner still types CONFIRM.
// Answers are stored with the keys and values of QUESTIONS (onboarding.mjs), so answers files and earlier
// onboarding.json files keep working; the questions it does not ask (executor_tool, domain, external_artifacts)
// keep their earlier answer or their safe default.
import { DELIVERED_WHEN_DEFAULT, LOCALES, catalog, readOnboarding, remoteOwner } from './onboarding.mjs';

export const BLOCKS = ['security', 'operation', 'environment'];
export const TOTAL = 15;
const SECONDS_PER_QUESTION = 20;

// One entry per question: the answer key it fills and its options (value stored, in order of the numbers shown).
// `ask` marks an option that is followed by one short typed answer (an account name, a place).
export const WIZARD = [
  { block: 'security', key: 'end_user_input', options: ['no', 'yes', 'unsure'] },
  { block: 'security', key: 'never_leaves', options: [[], ['customer personal details'], ['payment or bank details'], ['passwords and access keys'], ['not sure: treat all data as private']] },
  { block: 'security', key: 'risk_default', options: ['high', 'medium', 'low'] },
  { block: 'security', key: 'approve_from', options: ['sheet', 'terminal'] },
  { block: 'security', key: 'github_owner', options: ['detected', { ask: 'account' }, 'none'] },
  { block: 'operation', key: 'purpose', options: ['a website', 'an app people use', 'an internal tool for the team', 'data, reports or automation', 'another kind of project'] },
  { block: 'operation', key: 'in_use', options: ['yes', 'no'] },
  { block: 'operation', key: 'how_verified', options: ['tests', 'page', 'person'] },
  { block: 'operation', key: 'wip_limit', options: [1, 2, 3] },
  { block: 'operation', key: 'delivered_when', options: [DELIVERED_WHEN_DEFAULT, 'when the checks pass'] },
  { block: 'environment', key: 'owner_locale', options: ['en', 'es', 'pt', 'hi', 'zh-Hans'] },
  { block: 'environment', key: 'hosting', options: ['later', 'managed', 'own-server', { ask: 'place' }] },
  { block: 'environment', key: 'deploy_target', options: ['none', 'the main branch publishes the live version', 'published by hand'] },
  { block: 'environment', key: 'cloud_sessions', options: ['no', 'yes'] },
  { block: 'environment', key: 'budget_monthly_usd', options: ['unknown', 20, 50, 100, 300] },
];

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The options shown for question i (0-based): the detected account is offered only when one was found.
function optionsOf(i, ctx) {
  const q = WIZARD[i];
  return q.options.map((value, n) => ({ n: n + 1, value, label: `w.o.${i + 1}.${n + 1}` }))
    .filter((o) => o.value !== 'detected' || ctx.detected);
}

// The stored value an option stands for (detected account, typed account or place, or the plain value).
const valueOf = (o, ctx, typed) => (o.value === 'detected' ? ctx.detected : o.value?.ask === 'account' ? typed : o.value?.ask === 'place' ? `already: ${typed}` : o.value);

// A stored answer shown back to the owner: the option label when it is one of the options, else the value itself.
function shown(t, i, value, ctx) {
  if (value === undefined) return '—';
  if (WIZARD[i].key === 'budget_monthly_usd' && value === 0) value = 'unknown'; // 0 with the alerts off = not known
  const o = optionsOf(i, ctx).find((x) => (x.value === 'detected' ? value === ctx.detected : !x.value?.ask && same(x.value, value)));
  if (o) return t(o.label, { account: ctx.detected ?? '' });
  if (WIZARD[i].key === 'hosting' && String(value).startsWith('already: ')) return `${t(`w.o.${i + 1}.4`)}: ${String(value).slice(9)}`;
  return Array.isArray(value) ? (value.join(', ') || '—') : String(value);
}

export function progressLine(t, i, answered) {
  const block = WIZARD[i].block;
  const inBlock = WIZARD.filter((q, k) => q.block === block && answered.has(k)).length;
  const pct = Math.round((answered.size / TOTAL) * 100);
  const min = Math.ceil(((TOTAL - answered.size) * SECONDS_PER_QUESTION) / 60);
  return t('w.progress', { block: t(`w.block.${block}`), bar: `${'■'.repeat(inBlock)}${'□'.repeat(5 - inBlock)}`, done: inBlock, pct, min });
}

// Runs the wizard. ask(prompt) returns the owner's line; out(text) prints. Returns { provided, locale }:
// provided holds raw answers for resolveAnswers (a key is left out when the owner kept an earlier free-text answer).
export async function wizard(root, { locale: startLocale = 'en', ask, out }) {
  const previous = readOnboarding(root).answers ?? {};
  const ctx = { detected: remoteOwner(root) ?? (previous.github_owner?.value && previous.github_owner.value !== 'none' ? previous.github_owner.value : null) };
  const chosen = new Map(); // index -> stored value
  const answered = new Set();
  let locale = LOCALES.includes(previous.owner_locale?.value) ? previous.owner_locale.value : startLocale;
  let t = catalog(locale);
  const current = (i) => (chosen.has(i) ? chosen.get(i) : previous[WIZARD[i].key]?.value);

  out(`${t('w.title')}\n${t('w.howto')}`);
  // Asks question i; returns 'back' or 'ok'.
  const askOne = async (i, { allowBack = true } = {}) => {
    const opts = optionsOf(i, ctx);
    for (;;) {
      const lines = ['', `${t('w.question', { n: i + 1, total: TOTAL })} · ${progressLine(t, i, answered)}`, t(`w.q.${i + 1}`)];
      opts.forEach((o, k) => lines.push(`  ${k + 1}. ${t(o.label, { account: ctx.detected ?? '' })}`));
      if (current(i) !== undefined) lines.push(`  ${t('w.current', { value: shown(t, i, current(i), ctx) })}`);
      const raw = (await ask(`${lines.join('\n')}\n> `)).trim();
      if (raw === '' && current(i) !== undefined) { answered.add(i); return 'ok'; }
      if (raw === '0' && allowBack) {
        if (i === 0) { out(t('w.first')); continue; }
        return 'back';
      }
      const k = Number(raw);
      if (!Number.isInteger(k) || k < 1 || k > opts.length) { out(t('w.invalid', { max: opts.length })); continue; }
      const o = opts[k - 1];
      let typed;
      if (o.value?.ask) {
        typed = (await ask(`${t(o.value.ask === 'account' ? 'w.type_account' : 'w.type_place')}\n> `)).trim();
        if (!typed || (o.value.ask === 'account' && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(typed))) { out(t('w.invalid_typed')); continue; }
      }
      chosen.set(i, valueOf(o, ctx, typed));
      answered.add(i);
      if (WIZARD[i].key === 'owner_locale') { locale = chosen.get(i); t = catalog(locale); }
      return 'ok';
    }
  };

  for (let i = 0; i < TOTAL;) {
    if ((await askOne(i)) === 'back') i -= 1;
    else i += 1;
  }
  // The summary: every answer, then change any of them or go on.
  for (;;) {
    const lines = ['', t('w.summary')];
    WIZARD.forEach((q, i) => lines.push(`  ${i + 1}. ${t(`w.q.${i + 1}`)} → ${shown(t, i, current(i), ctx)}`));
    const raw = (await ask(`${lines.join('\n')}\n${t('w.summary_change')}\n> `)).trim();
    if (raw === '') break;
    const k = Number(raw);
    if (!Number.isInteger(k) || k < 1 || k > TOTAL) { out(t('w.invalid', { max: TOTAL })); continue; }
    await askOne(k - 1, { allowBack: false });
  }
  // A question kept with Enter is left out, so resolveAnswers keeps the earlier answer as it was.
  const provided = {};
  WIZARD.forEach((q, i) => { if (chosen.has(i)) provided[q.key] = chosen.get(i); });
  return { provided, locale };
}
