// An order says what it replaces (ORD-0042 part 7, OBS-149). The key `replaces:` of an order is an inline list of
// paths of the project that the work of the order replaces and that must be gone when it is delivered; `[]` says,
// on purpose, that it replaces nothing. `aos replaced check <ID>` looks at the newest commit of the order: every
// path of the list no longer exists there. It is meant for verify files.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RuleError } from './state.mjs';
import { parseFrontMatter } from './validate.mjs';
import { resolveOrderCommit } from './verify-refs.mjs';

// A path of `replaces:` is relative to the project root, with "/" separators and no "..".
export const isProjectPath = (p) => typeof p === 'string' && p.trim() !== '' && !/^([A-Za-z]:|[\\/])/.test(p) && !p.includes('\\') && !p.split('/').includes('..');

// The value of the key in an order text: undefined when the order has no such key, else the list (maybe empty).
export function replacesOf(text) {
  let field;
  try { field = parseFrontMatter(text).fields.get('replaces'); } catch { return undefined; }
  if (!field) return undefined;
  return Array.isArray(field.value) ? field.value : [field.value];
}

// { key: false } without the key; else { key: true, paths, commit, still }: `still` are the paths that exist at the
// newest commit of the order. E_NO_ORDER without an order file; E_NO_ORDER_COMMIT when a list cannot be judged yet.
export function replacedCheck(root, id) {
  const file = [`.analucia/orders/${id}.md`, `.analucia/drafts/${id}.md`].find((rel) => existsSync(join(root, rel)));
  if (!file) throw new RuleError('E_NO_ORDER', `no order file .analucia/orders/${id}.md (nor a draft of it)`);
  const paths = replacesOf(readFileSync(join(root, file), 'utf8'));
  if (paths === undefined) return { key: false };
  if (!paths.length) return { key: true, paths: [], commit: null, still: [] };
  const commit = resolveOrderCommit(root, id);
  if (!commit) throw new RuleError('E_NO_ORDER_COMMIT', `no commit has the trailer line "Analucia-Order: ${id}": the ${paths.length} path(s) it replaces cannot be judged yet`);
  const still = paths.filter((p) => spawnSync('git', ['-C', root, 'ls-tree', '--name-only', commit, '--', p.replace(/\/+$/, '')], { encoding: 'utf8' }).stdout.trim() !== '').sort();
  return { key: true, paths, commit, still };
}
