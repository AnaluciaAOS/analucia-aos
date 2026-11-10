# E_FIELD_TYPE

Who acts: `director`

## What happened

A field has the wrong type: a date that is not `YYYY-MM-DD`, a budget that is not a positive integer, a scalar where a list is required, a non-object payload, or a malformed lock or verify file entry.

## What to do next

**Change the value named in the message to the stated type (date YYYY-MM-DD, positive integer, inline list, object or string).** (director)

1. Director (orders, verify files, lock) or owner (project.json): fix the value, then `node plugins/analucia/bin/aos.mjs validate` until it exits 0.
2. Executor: if the field is in a director file, finish with `node plugins/analucia/bin/aos.mjs run finish ORD-NNNN --outcome needs_decision …`.

## Patterns

- Follow the table in `plugins/analucia/core/ORDER_FORMAT.md`.

## Trade-offs

- Strict types make derivation deterministic; free text goes in `notes`.

## Gotchas

- Lists use the inline form `[a, b]`; block lists are rejected.
