# E_MISSING_FIELD

Who acts: `director`

## What happened

A required key is missing or empty: an order key (`id`, `title`, `kind`, `created`, `budget_max_minutes`, `budget_max_attempts`), an event key, a verify-file key, the lock `files`, or a required CLI option.

## What to do next

**Add the required field named in the message and run aos validate again.** (director)

1. Director: add the key to the file; check with `node plugins/analucia/bin/aos.mjs validate`.
2. CLI option missing (for example `--evidence`, `--reason`): run the command again with it.

## Patterns

- Start new orders from an existing valid one and `plugins/analucia/core/ORDER_FORMAT.md`.

## Trade-offs

- Required budgets force a decision up front.

## Gotchas

- An empty value (`title:`) counts as missing.
