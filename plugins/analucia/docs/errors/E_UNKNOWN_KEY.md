# E_UNKNOWN_KEY

Who acts: `director`

## What happened

A key is not allowed: in an order front matter, project.json, an event, a verify file or the lock.

## What to do next

**Remove the key named in the message or rename it to an allowed key.** (director)

1. Director/owner: fix the file; check with `node plugins/analucia/bin/aos.mjs validate`.
2. Free text belongs in `notes` (orders) or the payload (events).

## Patterns

- Allowed keys: `plugins/analucia/core/ORDER_FORMAT.md`, SPEC-0001 §11, SPEC-0002 §5.

## Trade-offs

- Rejecting unknown keys stops silent drift of the format.

## Gotchas

- Nothing was written when this error appeared; fix the cause and run the command again.
