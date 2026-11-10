# AD-SECRET-HISTORY

Severity: `high` · Who acts: `owner` · Check of `aos adopt` (SPEC-0006 §4)

## What happened

The same patterns appear somewhere in the git history, on any branch, including files that were later deleted. The audit reports the first commit that introduced each one.

## What to do next

**Rotate the credential first (owner, `high` order). Cleaning the history is a second order, after rotating, because it rewrites published commits.** (owner)

The audit is read only and proposes the order as text in `.analucia/views/adoption.md`; the director writes it after the owner reads the report. Run `node plugins/analucia/bin/aos.mjs adopt` again to confirm.

## Patterns

- Treat every secret that ever reached a commit as exposed.

## Trade-offs

- History cleaning needs every clone to be refreshed; rotation does not.

## Gotchas

- Deleting the file does not remove it from history.
