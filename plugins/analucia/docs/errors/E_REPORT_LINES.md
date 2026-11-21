# E_REPORT_LINES

Who acts: `executor`

## What happened

`aos run finish --outcome done` was asked to deliver an order whose report lacks a line that the verify file of the order looks for (its `report_lines`). The message lists each missing line with the form it must have. Nothing was recorded, the run stays open and no attempt was consumed.

## What to do next

**Write the listed lines in the report in their exact form, check with aos report check, then finish the run again.** (executor)

1. `node plugins/analucia/bin/aos.mjs report check ORD-NNNN` prints what is missing: the lines of the verify file and the fixed sections.
2. Write each line in the report, in the exact form its pattern asks for.
3. `node plugins/analucia/bin/aos.mjs run finish ORD-NNNN --outcome done --evidence .analucia/evidence/ORD-NNNN/report.md`.

## Patterns

- Start a report with `aos report template ORD-NNNN`: the skeleton with the fixed sections and one line to fill per entry of `report_lines`.
- When a report is written again whole, run `aos report check ORD-NNNN` before finishing: a rewrite is where a line gets lost.
- The director puts the lines a report must carry in `report_lines` of the verify file, not in hand-written `grep` checks.

## Trade-offs

- The pattern is tried on each line of the report: a line that is almost right (one more space, another word) is a missing line.

## Gotchas

- Only `done` is held. Any other outcome is accepted with a line missing, because the order is not finished yet.
- A line whose value does not exist yet (a publication that was not made) cannot be written truthfully: the work is not complete, so the outcome is not `done`.
- `aos verify` tries the same lines as checks of class form: only the owner can waive one, at the signature, with a written reason.
