# E_UNKNOWN_CODE

Who acts: `executor`

## What happened

`aos explain` was given a code that is not in the registry `plugins/analucia/lib/errors.mjs`.

## What to do next

**Run aos explain with one of the close matches it listed.** (executor)

1. `node plugins/analucia/bin/aos.mjs explain <CODE>` with a listed code; all pages are in `plugins/analucia/docs/INDEX.md`.

## Patterns

- Use the `aos` commands for every state change; they apply the rules for you.

## Trade-offs

- None specific: the rule is cheap to follow and the check costs nothing at runtime.

## Gotchas

- Codes are uppercase with underscores.
