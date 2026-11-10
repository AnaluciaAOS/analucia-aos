// QRSPI as a template, not a lifecycle (AMD-0007 §3, ORD-0023 part C), and the open-orders hint of "aos admit"
// (AMD-0007 §4, part D). Neither touches the order states.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readLog } from './log.mjs';
import { reviewState } from './review.mjs';
import { replay } from './state.mjs';
import { parseFrontMatter } from './validate.mjs';

// The stages and the file each one produces under .analucia/artifacts/<ORDER>/ (Implement produces the code itself).
export const QRSPI_STAGES = [
  ['Questions', 'questions.md'], ['Research', 'research.md'], ['Design', 'design.md'],
  ['Structure', 'structure.md'], ['Plan', 'plan.md'], ['Implement', null],
];
// The documents that need a current approve before the order can pass its verify check.
export const QRSPI_GATES = ['design.md', 'plan.md'];

export const artifactPath = (id, file) => `.analucia/artifacts/${id}/${file}`;

const orderFields = (root, id) => {
  const p = join(root, '.analucia', 'orders', `${id}.md`);
  return existsSync(p) ? parseFrontMatter(readFileSync(p, 'utf8')).fields : null;
};

// aos workflow check ORD-NNNN: ok when design.md and plan.md each have an approve for their current content.
export function workflowCheck(root, id) {
  const fields = orderFields(root, id);
  if (!fields) return { ok: false, lines: [`${id}: no order file .analucia/orders/${id}.md`] };
  const workflow = fields.get('workflow')?.value ?? null;
  const lines = [];
  if (workflow !== 'qrspi') lines.push(`${id}: the order does not declare "workflow: qrspi"; checking its QRSPI documents anyway`);
  const docs = new Map(reviewState(root).map((d) => [d.path, d]));
  let ok = true;
  for (const file of QRSPI_GATES) {
    const path = artifactPath(id, file);
    const d = docs.get(path);
    const status = !existsSync(join(root, path)) ? 'missing' : !d ? 'not requested' : d.status;
    if (status !== 'approve') ok = false;
    lines.push(`${status === 'approve' ? 'PASS' : 'FAIL'} ${path}: ${status === 'approve' ? `approved by the owner ${d.decision.ts}` : status}`);
  }
  return { ok, lines };
}

// Orders that are not closed, for the reminder printed by "aos admit" (information only, it never blocks).
export function openOrders(root, events = readLog(root).events) {
  const orders = replay(events).orders;
  return Object.keys(orders).sort().filter((id) => orders[id].state !== 'closed').map((id) => {
    const title = orderFields(root, id)?.get('title')?.value ?? '';
    return { id, title, state: orders[id].state };
  });
}
