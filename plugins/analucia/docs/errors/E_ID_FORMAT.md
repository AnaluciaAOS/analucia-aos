# E_ID_FORMAT

Who acts: `director`

## What happened

An order `id` (or verify-file `order`) does not match `^ORD-\d{4}(\.[A-Z])?$`, or an event `id` is not a ULID.

## What to do next

**Use an ID of the right format: ORD-0000 or ORD-0000.A for orders, a 26-character ULID for events.** (director)

1. Director: rename the order with a valid ID (IDs are never reused).
2. Event IDs are set by `aos event append`; a bad one means the log was written by hand: see `aos explain E_CHAIN`.

## Patterns

- Phases are child orders: `ORD-0042.A`.

## Trade-offs

- Fixed formats keep IDs sortable and greppable.

## Gotchas

- Four digits exactly: `ORD-001` is invalid.
