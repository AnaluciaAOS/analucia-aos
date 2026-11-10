# E_NOT_LOCKED

Who acts: `director`

## What happened

`aos admit` refused an order that is not listed in `.analucia/director.lock`.

## What to do next

**Add the order file and its sha256 (LF-normalized) to .analucia/director.lock, then run aos admit again.** (director)

1. Director: add `".analucia/orders/ORD-NNNN.md": "<sha256>"` to the lock, then `node plugins/analucia/bin/aos.mjs admit ORD-NNNN`.

## Patterns

- Write the order, lock it, then admit: a locked definition is what the executor runs and the system verifies.

## Trade-offs

- None specific: the rule is cheap to follow and the check costs nothing at runtime.

## Gotchas

- Hashes are over LF-normalized bytes, so compute them the same way `aos verify` does.
