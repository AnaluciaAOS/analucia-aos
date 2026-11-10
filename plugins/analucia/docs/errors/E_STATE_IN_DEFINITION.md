# E_STATE_IN_DEFINITION

Who acts: `director`

## What happened

An order file has a `state:` key. Orders are definitions; their state lives only in `.analucia/events.jsonl`.

## What to do next

**Remove the state key from the order file; state is derived from the event log.** (director)

1. Director: remove the key; check with `node plugins/analucia/bin/aos.mjs validate`; read state with `node plugins/analucia/bin/aos.mjs derive`.

## Patterns

- Use the `aos` commands for every state change; they apply the rules for you.

## Trade-offs

- One source of truth beats a convenient copy that drifts.

## Gotchas

- Nothing was written when this error appeared; fix the cause and run the command again.
