# E_FORM_CLASS

Who acts: `director`

## What happened

A check of a verify file carries `"class": "form"`, and its command runs the test suite, `aos verify-log`, `aos validate`, `aos check-roles` or the release guard. Those are checks of substance by nature. A check of form is one the owner may waive at the signature with a written reason; the work, the tests, the log, secrets, the protected paths and the allowed paths can never be waived, so they can never be marked form.

## What to do next

**Remove "class": "form" from the check named in the message: the tests, the log, the order files, the roles and the release guard are substance and are never waived.** (director)

1. Open the verify file at the line of the message.
2. Delete the key `class` from that check (a check without the key is a check of substance).
3. `node plugins/analucia/bin/aos.mjs validate` again; refresh `director.lock` as for any change of a director file.

## Patterns

- Form is only what does not change what was built or how safely: a trailer on a commit that touches only evidence, a label or a heading of the report, the name of the branch the signature is made from.

## Trade-offs

- The list of refused commands is short and fixed. Any other check is classified by the director, who answers for it: the verify file is under the lock, and an executor cannot reclassify a check.

## Gotchas

- A waiver exists only in `aos sign`, at the owner's terminal, and only when every failed check of the order is of class form. One failed check of substance and nothing is offered.
- `aos verify` never waives: it runs every check and reports the failed ones in two groups.
