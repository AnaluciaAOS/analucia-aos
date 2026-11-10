# E_KIND_ENUM

Who acts: `director`

## What happened

The order `kind` is not one of `build`, `fix`, `hotfix`, `data_op`, `migration`, `ux`, `research`.

## What to do next

**Set kind to one of the order_kinds in plugins/analucia/core/enums.json.** (director)

1. Director: fix the kind in the order (or by amendment); check with `node plugins/analucia/bin/aos.mjs validate`.

## Patterns

- Pick the kind by its extra gate (SPEC-0001 §3).

## Trade-offs

- Seven kinds cover the work; nuance goes in the title or notes.

## Gotchas

- "casi listo" and similar free text are exactly what this rejects.
