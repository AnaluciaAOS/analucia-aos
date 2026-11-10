# E_BLOCKED_NO_REF

Who acts: `executor`

## What happened

An `order.state_changed` event to `blocked` has no `payload.blocked_by`. A blocked order must say what it waits for.

## What to do next

**Give the blocked transition a blocked_by value (an ask, order or decision ID, or a reason) and record it again.** (executor)

1. Executor: `node plugins/analucia/bin/aos.mjs run finish ORD-NNNN --outcome blocked --evidence <report> --blocked-by ASK-NNNN --reason "<what is missing>"`.
2. Without an ask ID, `--reason` alone is used as `blocked_by`.

## Patterns

- Prefer an ask ID: it puts the item on the owner board under Pending signatures.

## Trade-offs

- A free-text reason is quicker but is not tracked as an owner ask.

## Gotchas

- `blocked` also needs `payload.reason` (a separate `E_TRANSITION` if it is missing).
