# AD-HYGIENE

Severity: `medium` · Who acts: `director` · Check of `aos adopt` (SPEC-0006 §4)

## What happened

A binary or archive file larger than 5 MB is tracked (zip, rar, bak, sql dumps …), a non-code file sits inside a code folder, or two migrations share the same numeric prefix.

## What to do next

**Move the file out of the repository (an artifact store or backup location), or rename the duplicated migration, through a `fix` order.** (director)

The audit is read only and proposes the order as text in `.analucia/views/adoption.md`; the director writes it after the owner reads the report. Run `node plugins/analucia/bin/aos.mjs adopt` again to confirm.

## Patterns

- Keep large artifacts out of git; record where they live.

## Trade-offs

- Removing a large file from history needs a rewrite, like secrets.

## Gotchas

- Running the audit twice on an unchanged project gives the same findings.
