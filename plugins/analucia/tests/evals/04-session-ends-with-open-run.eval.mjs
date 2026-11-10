// A session that ends with a run still open is blocked (Stop / PreCompact hook), and passes once it is finished.
export default {
  name: 'session-ends-with-open-run',
  description: 'check-writeback exits 2 while a run is open, 0 after run finish',
  expect: [{ exit: 2 }, { exit: 0 }],
  async run(sb) {
    const root = sb.project({ orders: [{ id: 'ORD-0001' }] });
    sb.aos(root, ['run', 'start', 'ORD-0001']);
    const open = sb.aos(root, ['check-writeback']);
    sb.aos(root, ['run', 'finish', 'ORD-0001', '--outcome', 'done', '--evidence', '.analucia/evidence/report.md']);
    return [open, sb.aos(root, ['check-writeback'])];
  },
};
