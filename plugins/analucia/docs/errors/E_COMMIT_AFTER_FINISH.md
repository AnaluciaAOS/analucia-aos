# E_COMMIT_AFTER_FINISH

Who acts: `executor`

## What happened

A commit being pushed carries the trailer of an order (`Analucia-Order: <ID>`) and is dated after the last `run.finished` of that order, while no run of it is open. That work was done outside any run: nobody budgeted it and no report covers it. The push was refused; nothing left the computer.

## What to do next

**Stop committing for that order: write what you found in the report as pending and tell the director, who opens a new run or a new order for it.** (executor)

1. Do not amend, rebase or re-date the commit to get it through.
2. Tell the director which commit it is and what it changes. The director decides: a new run of the same order (`node plugins/analucia/bin/aos.mjs run start <ID>` when it is queued, and the commit then belongs to an open run) or a new order.
3. Next time: after `run finish` you commit nothing.

## Patterns

- Commit and push what is finished, write the report, then `run finish`. The owner's sign-off commit touches only the log and the evidence and is not affected.

## Trade-offs

- The guard compares dates: a commit made between two runs and pushed after the second one is finished is not caught.

## Gotchas

- Commits that touch only owner and director paths (the log, evidence, orders, amendments, verify files) are never judged by this rule.
