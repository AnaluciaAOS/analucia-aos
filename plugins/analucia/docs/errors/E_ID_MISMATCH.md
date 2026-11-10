# E_ID_MISMATCH

Who acts: `director`

## What happened

The `id` of an order, or the `order` of a verify file, differs from its file name.

## What to do next

**Make the id (or order) field equal the file name without its extension.** (director)

1. Director: rename the file or fix the field; check with `node plugins/analucia/bin/aos.mjs validate`.

## Patterns

- One file per record, named by its ID.

## Trade-offs

- Redundant on purpose: it catches copy-paste mistakes.

## Gotchas

- The comparison is case-sensitive.
