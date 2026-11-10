# E_SHEET_VALUE

Who acts: `owner`

## What happened

`aos ceo import` found values it cannot record: a decision that is not one of the ask's options, a sign-off other than `close` or `hold`, a `close` on an order that is not `verified`, a decision on an ask that is already resolved, a comment without a decision, an unknown ID, or a file that is not a readable workbook. Import is all-or-nothing, so **nothing** was recorded.

## What to do next

**Fix the listed cells in the owner sheet (or export a fresh one with aos ceo export) and run aos ceo import again.** (owner)

1. Owner: read the cell references in the message (for example `Asks!F3`), pick a value from the drop-down, save.
2. Owner, in your own terminal: `node plugins/analucia/bin/aos.mjs ceo import <file>` and type `CONFIRM`.
3. If the sheet is old (states changed since), export a fresh one: `node plugins/analucia/bin/aos.mjs ceo export`.

## Patterns

- Fill only the yellow cells; values are English (approve, reject, change, close, hold) even when the sheet texts are Spanish.

## Trade-offs

- All-or-nothing means one bad cell holds back the good ones; in exchange, a half-applied sheet never happens.

## Gotchas

- Excel may auto-correct a typed value; use the drop-down.
- A sheet exported before an order changed state can carry a stale sign-off.
