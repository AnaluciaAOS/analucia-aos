# AD-SPOF

Severity: `high` · Who acts: `owner` · Check of `aos adopt` (SPEC-0006 §4)

## What happened

Code exists on one machine only: the repository has no remote, commits on the current branch are on no remote, or a large source file is untracked and not ignored.

## What to do next

**Push the work to a remote the owner controls (`git push`), or add one.** (owner)

The audit is read only and proposes the order as text in `.analucia/views/adoption.md`; the director writes it after the owner reads the report. Run `node plugins/analucia/bin/aos.mjs adopt` again to confirm.

## Patterns

- Push at least at the end of every batch.

## Trade-offs

- None specific: the check only reads files and git metadata.

## Gotchas

- Unpushed commits are reported until they are pushed, even during a batch.
