# E_REF_FORMAT

Who acts: `director`

## What happened

A relation field (`depends_on`, `parent`, `amends`, …) or an event `subject` is not a record ID, or an order event has no order subject.

## What to do next

**Replace the reference with a valid record ID (ORD-0000, DEC-0000, SPEC-0000, OBS-0000, AMD-0000, ASK-0000).** (director)

1. Director: fix the field; check with `node plugins/analucia/bin/aos.mjs validate`.
2. Event writer: pass `--subject ORD-NNNN` for order events.

## Patterns

- Relations are typed fields, never name suffixes.

## Trade-offs

- None specific: the rule is cheap to follow and the check costs nothing at runtime.

## Gotchas

- `parent` takes exactly one order ID.
