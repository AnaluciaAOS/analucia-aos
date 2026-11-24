# E_GREP_NON_ASCII

Who acts: `director`

## What happened

`aos validate`, `aos admit` or `aos drafts` found a check of a verify file that runs `grep` (or `egrep`) with a pattern that has a character outside ASCII (an accent, `ñ`, a Hindi or Chinese letter). In Git Bash on Windows such a check gives false alarms: in one order, 4 of the 5 failing checks were `grep` over text with accents that was in the file (OBS-206). The message names the check.

## What to do next

**Replace the grep check named in the message with aos text has <file> "<text>" (or aos text lacks), then run aos validate again.** (director)

1. Wrong: `grep -q 'acción' report.md`.
2. Right: `node plugins/analucia/bin/aos.mjs text has report.md 'acción'` (add `-i` to ignore case).
3. Refresh `director.lock` when the order is already placed, or write the draft again.

## Patterns

- `aos text has` and `aos text lacks` read the file as UTF-8, compare in NFC, accept `-i`, and exit 0 or 1.
- A pattern of pure ASCII keeps working with `grep`.

## Trade-offs

- The verify files of closed orders are history: they are not judged by this rule, so `aos validate` keeps exiting 0.

## Gotchas

- Only a `grep` whose command line carries the non-ASCII character is refused; the accent may be in the pattern or in the file name.
- An executor never fixes a verify file: it finishes the run with `needs_decision`.
