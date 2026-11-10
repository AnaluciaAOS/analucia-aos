// An order admitted under SPEC-0003 pins without a risk key is reported by validate.
export default {
  name: 'missing-risk',
  description: 'validate reports E_MISSING_FIELD for a pinned order without risk',
  expect: [{ exit: 1, code: 'E_MISSING_FIELD' }],
  async run(sb) {
    const root = sb.project({ pinned: true, orders: [{ id: 'ORD-0001', keys: ['cost_effect: none'] }] });
    return [sb.aos(root, ['validate'])];
  },
};
