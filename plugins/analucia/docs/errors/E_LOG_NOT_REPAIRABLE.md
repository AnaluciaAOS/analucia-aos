# E_LOG_NOT_REPAIRABLE

Who acts: `director`

## What happened

`aos repair-log` (the launcher REPARAR) was asked to repair the event log, and one of its three conditions does not hold. The message says which: (1) the log verifies, so there is nothing to repair; (2) the version of the log in the last commit does not verify, or there is none; (3) the lines after the committed version are not all session lines, or a committed line was changed, so a repair would lose an order, a run, an evidence, a review or a signature. Nothing was changed.

## What to do next

**Restore .analucia/events.jsonl from git and confirm with aos verify-log, because the repair only removes session lines that were not committed.** (director)

1. `node plugins/analucia/bin/aos.mjs verify-log` names the first broken line.
2. Director: compare the working log with the committed one (`git diff .analucia/events.jsonl`), restore the last committed log, then record again with `aos` commands the events that were lost.
3. Nobody continues until `aos verify-log` ends with `OK:`.

## Patterns

- Two sessions that end in the same instant with an old plugin can each append a session line from the same last line: that is the one damage the repair is for.

## Trade-offs

- The repair is narrow on purpose: it never guesses which of two lines is right, it only removes lines whose loss changes the state of no order.

## Gotchas

- The removed lines are kept under `.analucia/views/`, in a file named with the time; that folder is never committed.
- Agents cannot run the repair (`E_OWNER_TTY`).
