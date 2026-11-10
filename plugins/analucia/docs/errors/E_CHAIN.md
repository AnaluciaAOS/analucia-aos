# E_CHAIN

Who acts: `director`

## What happened

The hash chain of `.analucia/events.jsonl` is broken: a line's `prev` is not the sha256 of the previous line's raw bytes (or line 1 has a non-null `prev`). Some line was edited, removed or reordered.

## What to do next

**Restore .analucia/events.jsonl from git and confirm with aos verify-log; nobody edits the log by hand.** (director)

1. Everyone: `node plugins/analucia/bin/aos.mjs verify-log` to see the first broken line.
2. Director: `git diff .analucia/events.jsonl`, then `git checkout -- .analucia/events.jsonl` to restore the last committed log, then replay the lost events with `aos` commands.
3. Executor: stop; the Stop hook stays blocked until the chain is intact.

## Patterns

- Write events only through `aos` commands; they append one line and set `prev`.

## Trade-offs

- The chain detects edits but not an edit of the last line, which has no successor; the committed history covers that.

## Gotchas

- `.gitattributes` keeps `*.jsonl` LF; a CRLF conversion breaks every link.
