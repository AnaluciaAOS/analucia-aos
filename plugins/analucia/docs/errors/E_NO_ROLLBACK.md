# E_NO_ROLLBACK

Who acts: `director`

## What happened

`aos run start` refused a `risk: high` order: its `rollback` key does not name `.analucia/rollback/ORD-NNNN.md`, the file does not exist, or `director.lock` does not list it.

## What to do next

**Write the rollback plan .analucia/rollback/ORD-NNNN.md, name it in the order rollback key and list it in director.lock.** (director)

1. Executor: stop; the run did not start and nothing was written.
2. Director: write the plan (how to undo, how to check the undo), set `rollback: .analucia/rollback/ORD-NNNN.md` in the order, add both files to `director.lock`.
3. Then the executor runs `node plugins/analucia/bin/aos.mjs run start ORD-NNNN` again.

## Patterns

- A rollback plan names the exact commands and the check that proves the undo worked.

## Trade-offs

- Writing the plan first costs time before every high-risk run; it is the price of being able to undo.

## Gotchas

- Rollback files are protected paths: only the director writes them.
