# E_RISK_CLOSE

Who acts: `owner`

## What happened

`aos close --as <role>` was refused: either the role is not `director`, or an order is not `risk: low` (medium, high, or admitted before SPEC-0003).

## What to do next

**Close this order yourself from your own terminal with aos close ORD-NNNN; only risk: low orders may be closed with --as director.** (owner)

1. Owner: `node plugins/analucia/bin/aos.mjs close ORD-NNNN` in your own terminal and type `CLOSE`.
2. Director: use `--as director` only for verified `risk: low` orders.
3. Executor: never close.

## Patterns

- Low-risk orders flow without the owner; everything else waits for the owner signature.

## Trade-offs

- `--as director` has no TTY check, so it is limited to the lowest tier on purpose.

## Gotchas

- Orders admitted without pins (ORD-0001..0007) are never low for this purpose.
