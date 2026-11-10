# E_PREV_FORMAT

Who acts: `director`

## What happened

An event `prev` is neither `null` nor a lowercase sha256 hex string. The log was written outside `aos`.

## What to do next

**Restore .analucia/events.jsonl from git; prev values are written only by aos.** (director)

1. Director: restore as in `aos explain E_CHAIN`.

## Patterns

- Only `aos event append` and the lifecycle commands write the log.

## Trade-offs

- None specific: the rule is cheap to follow and the check costs nothing at runtime.

## Gotchas

- Uppercase hex is rejected.
