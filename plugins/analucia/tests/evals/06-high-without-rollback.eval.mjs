// A high-risk order without a locked rollback plan never runs, and cannot be closed by the director.
// (SPEC-0003 §4 puts the rollback gate at run start; the order can then never reach close.)
export default {
  name: 'high-without-rollback',
  description: 'a high order without rollback is refused at run start (E_NO_ROLLBACK) and at close (E_RISK_CLOSE)',
  expect: [{ exit: 1, code: 'E_NO_ROLLBACK' }, { exit: 1, code: 'E_RISK_CLOSE' }],
  async run(sb) {
    const root = sb.project({ pinned: true, orders: [{ id: 'ORD-0001', keys: ['risk: high', 'cost_effect: none', 'rollback: .analucia/rollback/ORD-0001.md'] }] });
    return [sb.aos(root, ['run', 'start', 'ORD-0001']), sb.aos(root, ['close', 'ORD-0001', '--as', 'director'])];
  },
};
