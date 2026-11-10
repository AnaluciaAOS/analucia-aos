# AD-ENV

Severity: `high` · Who acts: `owner` · Check of `aos adopt` (SPEC-0006 §4)

## What happened

A `.env`-like file (`.env`, `.env.local`, `prod.env` …) is tracked, or present and not git-ignored. Templates (`.env.example`, `.env.sample`, `.env.template`) are not reported.

## What to do next

**Through an order: `git rm --cached <file>`, add `.env` and `.env.*` to `.gitignore`, and rotate any value the file held.** (owner)

The audit is read only and proposes the order as text in `.analucia/views/adoption.md`; the director writes it after the owner reads the report. Run `node plugins/analucia/bin/aos.mjs adopt` again to confirm.

## Patterns

- Commit a `.env.example` with placeholder values instead.

## Trade-offs

- None specific: the check only reads files and git metadata.

## Gotchas

- A tracked file stays tracked even after it is added to `.gitignore`.
