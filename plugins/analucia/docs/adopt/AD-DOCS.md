# AD-DOCS

Severity: `medium` · Who acts: `director` · Check of `aos adopt` (SPEC-0006 §4)

## What happened

A README or a document under `docs/` names a file, a folder or an `npm run` script that does not exist in the tree. Ports are not checked (reported as not verified).

## What to do next

**Correct the document, or restore what it names, through a `fix` order.** (director)

The audit is read only and proposes the order as text in `.analucia/views/adoption.md`; the director writes it after the owner reads the report. Run `node plugins/analucia/bin/aos.mjs adopt` again to confirm.

## Patterns

- Documents are a contract with the next reader; keep them true.

## Trade-offs

- None specific: the check only reads files and git metadata.

## Gotchas

- Placeholders such as `<file>`, `ORD-NNNN` or `*.md` are not checked.
