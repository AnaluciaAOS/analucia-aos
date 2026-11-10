# AD-DEPS

Severity: `low` · Who acts: `director` · Check of `aos adopt` (SPEC-0006 §4)

## What happened

`package.json` declares dependencies without a lockfile, or declares a package with no version (`*`, `latest`, empty).

## What to do next

**Commit a lockfile and pin the versions through a `fix` order.** (director)

The audit is read only and proposes the order as text in `.analucia/views/adoption.md`; the director writes it after the owner reads the report. Run `node plugins/analucia/bin/aos.mjs adopt` again to confirm.

## Patterns

- Run the audit before the first order, and again after each fix.

## Trade-offs

- None specific: the check only reads files and git metadata.

## Gotchas

- Running the audit twice on an unchanged project gives the same findings.
