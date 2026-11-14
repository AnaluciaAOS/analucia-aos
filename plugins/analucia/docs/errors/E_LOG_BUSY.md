# E_LOG_BUSY

Who acts: `executor`

## What happened

A command had to append to `.analucia/events.jsonl`, but another process was writing the log and did not finish within the wait (10 seconds by default). Only one process at a time may be between "read the last line" and "append" (ORD-0040 part 1); the turn is the file `.analucia/events.jsonl.lock`. The command wrote nothing.

## What to do next

**Run the same command again in a moment; if it still fails, check that no other aos command is running in this project and tell the director.** (executor)

1. Run the same command again: the other writer normally needs a few milliseconds.
2. If it fails again, look for an `aos` process that is still running in this project (a long `node plugins/analucia/bin/aos.mjs verify`, for example) and let it finish.
3. Do not edit the log and do not append by hand. A lock left by a process that died is removed by the next writer on its own (at once when the process is gone, after 30 seconds in every other case).

## Patterns

- Every writer goes through `appendEvent`; nothing else writes the log.

## Trade-offs

- A bounded wait means a writer can fail under a very long queue; it fails cleanly and can be repeated, which a broken chain cannot.

## Gotchas

- The SessionEnd hook reports this code on stderr and still exits 0: it never blocks the end of a session.
- `.analucia/events.jsonl.lock` is never committed (it is in `.gitignore`).
