# E_DENYLIST_FILE

Who acts: `director`

## What happened

`aos admit` or `aos drafts` ran the list of forbidden names (`release_denylist` of `.analucia/project.json`) over the files of an order: the order, its verify file, its rollback plan and its request file. A line matched. In one order a forbidden name passed admission because those files were not yet in git, so the push guard had not seen them (OBS-191). The message gives the file, the line and the rule's position in the list, never the word.

## What to do next

**Remove the listed lines from the order files named in the message (the order, its verify file, its rollback plan or its request file), or restore the list file named by release_denylist in .analucia/project.json; then lock and admit again.** (director)

1. Open each `file:line` named and write the text without the name.
2. For an order already locked, refresh `director.lock`.
3. Run `aos admit ORD-NNNN` (or `aos drafts`) again.

## Patterns

- The matcher is the one the push guard uses: same list format, same whole-word prefix `w:`, case-insensitive.
- Tracked or not does not matter: the files are read from disk.

## Trade-offs

- With no `release_denylist` key nothing is checked; with the key set and the list missing the check fails closed.

## Gotchas

- The word is never printed: read the line at the position named.
- An executor never fixes a director file: it finishes the run with `needs_decision`.
