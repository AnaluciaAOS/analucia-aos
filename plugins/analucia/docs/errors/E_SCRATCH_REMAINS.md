# E_SCRATCH_REMAINS

Who acts: `executor`

## What happened

`aos run finish --outcome done` was asked to deliver an order while a copy of real data that the order recorded with `aos scratch add` is still there: a folder that still exists, or a process that is still running. The message lists each one. Nothing was recorded and the run stays open.

## What to do next

**Stop the listed processes and delete the listed folders, check with aos scratch check, then finish the run again.** (executor)

1. Stop each listed process and delete each listed folder. Delete only what the order names: the backups the order says are kept stay where they are.
2. `node plugins/analucia/bin/aos.mjs scratch check ORD-NNNN` must exit 0.
3. `node plugins/analucia/bin/aos.mjs run finish ORD-NNNN --outcome done --evidence .analucia/evidence/ORD-NNNN/report.md`.

## Patterns

- Declare the copy when it is made: `aos scratch add ORD-NNNN --path <folder> [--pid <n>]`. The record is `.analucia/evidence/ORD-NNNN/scratch.json`: names and numbers only, never content.
- The verify file of an order that copies real data runs `aos scratch check ORD-NNNN`.

## Trade-offs

- The tool knows only the copies that were recorded. A copy nobody declared is not found by it.

## Gotchas

- Only `done` is held. `budget_exhausted`, `blocked` and the other outcomes are accepted with a copy still there, because the next run may need it; the report says so.
- A recorded process number that was given to another process later counts as still running: stop it or check the number.
