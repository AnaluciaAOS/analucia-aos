# E_NO_ORDER_COMMIT

Who acts: `executor`

## What happened

`aos verify` could not resolve `{order_commit}` in a check: no commit reachable from `HEAD` has the trailer line `Analucia-Order: ORD-NNNN` of the order being verified. The check was not run and counts as failed; the evidence file shows it.

## What to do next

**Commit with the trailer Analucia-Order: ORD-NNNN of the order, then ask for verify.** (executor)

1. Commit the order's work with a message that ends with `Analucia-Order: ORD-NNNN`.
2. Push through the pre-push guard.
3. Ask the director to run `node plugins/analucia/bin/aos.mjs verify ORD-NNNN` again.

## Patterns

- `{order_commit}` is the newest such commit (full SHA), resolved once per verify, so a check like `git diff --quiet <base> {order_commit} -- core` stays fixed after later orders.

## Trade-offs

- A check that needs the order's own commit cannot pass before that commit exists; that is intended.

## Gotchas

- The trailer must be its own line, exactly `Analucia-Order: ORD-NNNN`, with no trailing text.
