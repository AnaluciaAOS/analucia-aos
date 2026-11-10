# E_DUPLICATE_KEY

Who acts: `director`

## What happened

The order front matter has the same key twice. Only the first value would count, so the file is ambiguous.

## What to do next

**Remove the repeated key from the front matter so each key appears once.** (director)

1. Director: edit the order (or issue an amendment) so the key appears once; check with `node plugins/analucia/bin/aos.mjs validate`.

## Patterns

- Keep the key order of `plugins/analucia/core/ORDER_FORMAT.md`.

## Trade-offs

- Rejecting duplicates costs a re-edit but avoids silent overrides.

## Gotchas

- Executors never edit orders: report it with outcome `needs_decision`.
