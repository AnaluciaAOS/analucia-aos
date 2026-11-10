# E_RECORD_EXISTS

Who acts: `director`

## What happened

A `record.created` (or `ask.opened`) names an ID that already exists in the log.

## What to do next

**Use a new record ID; IDs are never created twice or reused.** (director)

1. Check: `node plugins/analucia/bin/aos.mjs history <ID>`.
2. Director: pick the next free ID; to change an existing record, write an amendment.

## Patterns

- Renaming changes `title` and keeps the old one in `aliases`.

## Trade-offs

- None specific: the rule is cheap to follow and the check costs nothing at runtime.

## Gotchas

- Admission bootstraps run once per order.
