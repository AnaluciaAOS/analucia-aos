// A director file edited after it was locked is detected before anything is verified.
export default {
  name: 'director-file-edited',
  description: 'verify refuses with E_DIRECTOR_FILE_CHANGED after a locked order changed',
  expect: [{ exit: 1, code: 'E_DIRECTOR_FILE_CHANGED' }],
  async run(sb) {
    const root = sb.project({ orders: [{ id: 'ORD-0001' }] });
    sb.deliver(root, 'ORD-0001');
    const rel = ['.analucia', 'orders', 'ORD-0001.md'].join('/');
    sb.write(root, rel, sb.read(root, rel).replace('Eval order', 'Edited order'));
    return [sb.aos(root, ['verify', 'ORD-0001'])];
  },
};
