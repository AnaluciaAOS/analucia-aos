# E_FRONT_MATTER

Who acts: `director`

## What happened

The order file does not start with `---`, the front matter is not closed, or a line is not a flat `key: value` (nested keys, block lists, comments).

## What to do next

**Rewrite the order front matter as flat key: value lines between two --- lines.** (director)

1. Director: fix the front matter per `plugins/analucia/core/ORDER_FORMAT.md`; check with `node plugins/analucia/bin/aos.mjs validate`.
2. Executor: report with outcome `needs_decision`; never edit the order.

## Patterns

- Use inline lists: `depends_on: [ORD-0001, ORD-0002]`.

## Trade-offs

- A minimal format is less expressive than YAML but parses without dependencies.

## Gotchas

- A BOM or blank line before the first `---` breaks it.
