# E_WORKFLOW_ENUM

Who acts: `director`

## What happened

The optional order key `workflow` has a value other than `qrspi`. It names a template the order follows (AMD-0007 §3); it is not a lifecycle and does not change the order states.

## What to do next

**Remove the workflow key or set it to qrspi, then refresh director.lock.** (director)

1. The director edits the order: `workflow: qrspi`, or no `workflow` line at all.
2. Refresh the order hash in `.analucia/director.lock`, then `node plugins/analucia/bin/aos.mjs validate` again.

## Patterns

- Use `workflow: qrspi` only when the work needs questions, research and a design approved before the plan and the implementation.

## Trade-offs

- One template for now keeps the check simple; other templates need an amendment.

## Gotchas

- Without the key nothing changes.
