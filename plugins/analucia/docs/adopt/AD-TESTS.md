# AD-TESTS

Severity: `medium` · Who acts: `director` · Check of `aos adopt` (SPEC-0006 §4)

## What happened

No test command was found (`npm test`, a `tests/` folder, `*.test.*` or `test_*.py` files). When one exists, it is not run, because the audit is read only: it is reported as not verified.

## What to do next

**Add a test command through a `fix` order.** (director)

The audit is read only and proposes the order as text in `.analucia/views/adoption.md`; the director writes it after the owner reads the report. Run `node plugins/analucia/bin/aos.mjs adopt` again to confirm.

## Patterns

- Run the audit before the first order, and again after each fix.

## Trade-offs

- Running the project's own tests could write files, so the audit only detects them.

## Gotchas

- Running the audit twice on an unchanged project gives the same findings.
