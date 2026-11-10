# AD-BACKUP

Severity: `medium` · Who acts: `director` · Check of `aos adopt` (SPEC-0006 §4)

## What happened

No backup or deploy script is visible in the repository (`medium`); or a backup folder in the tree has its newest output older than 48 hours (`high`). Output kept outside the repository cannot be seen and is reported as not verified.

## What to do next

**Add a backup or deploy script with visible output, or record where it runs, through an order. A stale scheduled job is checked by the owner.** (director)

The audit is read only and proposes the order as text in `.analucia/views/adoption.md`; the director writes it after the owner reads the report. Run `node plugins/analucia/bin/aos.mjs adopt` again to confirm.

## Patterns

- Run the audit before the first order, and again after each fix.

## Trade-offs

- The audit cannot see a server or a cloud job; it says so instead of calling it clean.

## Gotchas

- Running the audit twice on an unchanged project gives the same findings.
