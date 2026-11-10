# E_PAUSED_NO_REASON

Who acts: `executor`

## What happened

An `order.state_changed` to `paused` has no `payload.reason`.

## What to do next

**Record the pause again with a reason in the payload.** (executor)

1. `node plugins/analucia/bin/aos.mjs event append --type order.state_changed --actor <role> --subject ORD-NNNN --payload '{"from":"active","to":"paused","reason":"<why>"}'`.

## Patterns

- A pause is on purpose; say whose purpose.

## Trade-offs

- None specific: the rule is cheap to follow and the check costs nothing at runtime.

## Gotchas

- Paused orders do not count toward wip_limit.
