# E_NO_ORDER

Who acts: `director`

## What happened

`aos run start` (or another lifecycle command) named an order that has no file under `.analucia/orders/`. No order file, no work.

## What to do next

**Write the order file .analucia/orders/ORD-NNNN.md; the executor does no work without it.** (director)

1. Executor: stop; do not create the file yourself.
2. Director: write the order, add it to `director.lock`, and admit it.

## Patterns

- The executor runs orders by ID only.

## Trade-offs

- Strictness prevents unrequested work.

## Gotchas

- Check the ID spelling: `ORD-0007` vs `ORD-007`.
