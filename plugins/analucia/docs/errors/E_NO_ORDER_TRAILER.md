# E_NO_ORDER_TRAILER

Who acts: `executor`

## What happened

`aos check-push` (the `pre-push` hook) found a pushed commit that changes a path outside the owner and director paths without an `Analucia-Order: ORD-NNNN` trailer, or whose trailer names an order with no `run.started` in the log (SPEC-0004 §4). Code enters only through an order.

## What to do next

**Amend the listed commit so its message ends with the trailer Analucia-Order: ORD-NNNN of the order you are running, then push again.** (executor)

1. Executor, last commit: `git commit --amend` and add the line `Analucia-Order: ORD-NNNN` at the end of the message (after `node plugins/analucia/bin/aos.mjs run start ORD-NNNN`).
2. Older commit: `git rebase -i <remote>/<branch>` is interactive and not for agents; ask the owner, or redo the work on a fresh commit with the trailer.
3. Work without an order: stop; the director writes the order first.

## Patterns

- One order, one or more commits, each ending with its trailer: `git commit -m "<summary>" -m "Analucia-Order: ORD-NNNN"`.
- Sign-offs, admissions, evidence and director files need no trailer.

## Trade-offs

- The guard makes unordered code impossible to push, at the cost of a trailer line per commit.

## Gotchas

- The trailer must be its own line, in the last paragraph, spelled exactly `Analucia-Order:`.
- Only paths under `core/*.md` (top level) count as director paths; `plugins/analucia/core/**` is code.
