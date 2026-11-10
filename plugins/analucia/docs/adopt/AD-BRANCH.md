# AD-BRANCH

Severity: `info` · Who acts: `owner` · Check of `aos adopt` (SPEC-0006 §4)

## What happened

Branch protection is not visible from the repository without a token, so it is always reported as not verified, as in SPEC-0005.

## What to do next

**If the plan allows it, require the `aos verify` check on the main branch; otherwise the control is the pre-push guard plus `aos verify`.** (owner)

The audit is read only and proposes the order as text in `.analucia/views/adoption.md`; the director writes it after the owner reads the report. Run `node plugins/analucia/bin/aos.mjs adopt` again to confirm.

## Patterns

- Run the audit before the first order, and again after each fix.

## Trade-offs

- None specific: the check only reads files and git metadata.

## Gotchas

- Running the audit twice on an unchanged project gives the same findings.
