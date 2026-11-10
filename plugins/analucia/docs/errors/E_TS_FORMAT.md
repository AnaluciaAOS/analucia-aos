# E_TS_FORMAT

Who acts: `director`

## What happened

An event `ts` is not ISO 8601 with an offset. `aos` always writes local time with offset, so the log was edited by hand.

## What to do next

**Restore .analucia/events.jsonl from git; timestamps are set by aos.** (director)

1. Director: restore as in `aos explain E_CHAIN`.

## Patterns

- Use the `aos` commands for every state change; they apply the rules for you.

## Trade-offs

- None specific: the rule is cheap to follow and the check costs nothing at runtime.

## Gotchas

- `Z` is accepted as an offset.
