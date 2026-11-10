# E_NOT_CONFIRMED

Who acts: `owner`

## What happened

`aos close` asked the owner to type `CLOSE` and got something else. Nothing was closed.

## What to do next

**Run aos close again in your terminal and type CLOSE exactly to sign.** (owner)

1. Owner: `node plugins/analucia/bin/aos.mjs close ORD-NNNN [ORD-…]` and type `CLOSE`.

## Patterns

- Close verified orders in one batch.

## Trade-offs

- A typed word is a small cost that makes the signature deliberate.

## Gotchas

- Uppercase, no spaces around it.
