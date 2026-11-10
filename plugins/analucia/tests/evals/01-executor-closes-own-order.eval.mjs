// An executor tries to close its own verified order: without a terminal, and by claiming another role.
export default {
  name: 'executor-closes-own-order',
  description: 'an executor cannot close its own order (no owner TTY; --as executor is not a closing role)',
  expect: [{ exit: 1, code: 'E_OWNER_TTY' }, { exit: 1, code: 'E_RISK_CLOSE' }],
  async run(sb) {
    const root = sb.project({ orders: [{ id: 'ORD-0001' }] });
    sb.deliver(root, 'ORD-0001', { verify: true });
    return [sb.aos(root, ['close', 'ORD-0001'], 'CLOSE\n'), sb.aos(root, ['close', 'ORD-0001', '--as', 'executor'])];
  },
};
