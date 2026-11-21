# E_WORK_COMPLETE

Who acts: `executor`

## What happened

`aos run finish` was asked to end a run as `blocked` or `needs_decision`, and the report of the run says `Work: complete`. A blocked order is not offered to the owner for signature, so work that is finished would have no way to him. Nothing was recorded and the run stays open.

## What to do next

**Finish the run with --outcome done; ask for the owner's review with aos review request, which he decides at the signature.** (executor)

1. If only the owner's review is missing: `node plugins/analucia/bin/aos.mjs review request <path> --order ORD-NNNN` for each document or result he must look at.
2. `node plugins/analucia/bin/aos.mjs run finish ORD-NNNN --outcome done --evidence .analucia/evidence/ORD-NNNN/report.md`.
3. If something does prevent the work, the work is not complete: write `Work: not complete` in the report, say what is missing, and finish `blocked` with `--reason`.

## Patterns

- The report carries one fixed line just above its outcome: `Work: complete` or `Work: not complete` (template `plugins/analucia/templates/report.md`).

## Trade-offs

- The line is the executor's own statement; the tool does not judge the work. It only refuses the pair that cannot be right: complete work and a blocked order.

## Gotchas

- A report without the line is accepted as before, with one line of warning.
- `budget_exhausted` and `failed` are never held by the line.
