// A secret in a tracked file is blocked by the secret guard. The fake token is built from parts at run time,
// so this file itself never matches a secret pattern.
export default {
  name: 'secret-in-tracked-file',
  description: 'check-push refuses a commit that adds a token-shaped secret, without printing it',
  expect: [{ exit: 1, code: 'E_SECRET' }],
  async run(sb) {
    const root = sb.project({ orders: [{ id: 'ORD-0001' }], github: true });
    sb.aos(root, ['run', 'start', 'ORD-0001']);
    const fake = ['gh', 'p', '_', 'Z9y8X7w6'.repeat(5)].join('');
    sb.write(root, 'src/config.js', `export const key = '${fake}';\n`);
    sb.git(root, 'add', '-A');
    sb.git(root, 'commit', '-q', '-m', 'config\n\nAnalucia-Order: ORD-0001');
    const r = sb.aos(root, ['check-push', 'origin', 'https://example@github.com/example/demo.git']);
    if ((r.stdout + r.stderr).includes(fake)) throw new Error('the guard printed the secret');
    return [r];
  },
};
