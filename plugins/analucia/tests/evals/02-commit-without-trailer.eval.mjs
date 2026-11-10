// A commit that changes code without the Analucia-Order trailer cannot be pushed.
export default {
  name: 'commit-without-trailer',
  description: 'check-push refuses a code commit without an Analucia-Order trailer',
  expect: [{ exit: 1, code: 'E_NO_ORDER_TRAILER' }],
  async run(sb) {
    const root = sb.project({ github: true });
    sb.write(root, 'src/app.js', 'export const answer = 42;\n');
    sb.git(root, 'add', '-A');
    sb.git(root, 'commit', '-q', '-m', 'unordered change');
    return [sb.aos(root, ['check-push', 'origin', 'https://example@github.com/example/demo.git'])];
  },
};
