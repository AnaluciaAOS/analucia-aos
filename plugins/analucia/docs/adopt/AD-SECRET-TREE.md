# AD-SECRET-TREE

Severity: `high` · Who acts: `owner` · Check of `aos adopt` (SPEC-0006 §4)

## What happened

A secret pattern (a provider key format, a private key block, a secret-like assignment in a `.env`-like file, or a credential in a URL) is in a file that git tracks. The audit names the kind, the file and the line; it never shows the value, not even a part of it.

## What to do next

**Rotate the credential first, at its provider: a `high` order that only the owner runs (Q-96). Then remove it from the repository with a second order.** (owner)

The audit is read only and proposes the order as text in `.analucia/views/adoption.md`; the director writes it after the owner reads the report. Run `node plugins/analucia/bin/aos.mjs adopt` again to confirm.

## Patterns

- Keep secrets in a secret store or environment variables read at run time.

## Trade-offs

- Removing the file without rotating leaves the credential valid for whoever already copied it.

## Gotchas

- A placeholder (`${VAR}`, `<value>`, `changeme`) is not reported.
