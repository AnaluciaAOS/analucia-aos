# E_DIRECTOR_FILE_CHANGED

Who acts: `director`

## What happened

`aos verify` found a director file (spec, order, amendment, verify file) whose sha256 (LF-normalized) differs from `.analucia/director.lock`, or is missing. Verification refuses to grade against changed rules.

## What to do next

**Restore the listed director files from git, or re-issue them and refresh .analucia/director.lock.** (director)

1. Director: `git diff -- <file>`; if the change is wrong, `git checkout -- <file>`; if it is intended, write it as an amendment and update the lock.
2. Then re-run `node plugins/analucia/bin/aos.mjs verify ORD-NNNN`.
3. Executor: never touch these files; finish with `needs_decision` if one looks wrong.

## Patterns

- Change orders through amendments under `.analucia/amendments/`, never in place.

## Trade-offs

- Any byte change blocks verification, even a typo fix; that strictness is what makes the evidence trustworthy.

## Gotchas

- A CRLF checkout is not a change: hashes are computed over LF-normalized bytes.
