# E_DENYLIST

Who acts: `owner`

## What happened

`aos check-push` read the list of forbidden names that `release_denylist` of `.analucia/project.json` points to, and found a name in an added line or a file name of a commit being pushed, or the list file is missing. The message names the commit, the file and the line and the position of the rule in the list, never the word (ORD-0046, OBS-198).

## What to do next

**Remove the listed lines from those commits (a history rewrite belongs to the owner), or restore the list file named by release_denylist in .analucia/project.json, then push again.** (owner)

1. Executor: stop with outcome `blocked` and report the commit, file and line; do not print the word.
2. Owner: remove the name from the listed commits (amend or rebase before the push) or, for a missing list, put the file back.

## Patterns

- Keep the list outside the repository and name it in `release_denylist`; the release guard keeps checking the files as they are.

## Trade-offs

- Checking every added line of every pushed commit catches a name that a later commit removed; a push of many commits takes a little longer.

## Gotchas

- Deleting the name in a later commit is not enough: the earlier commit still carries it and is refused.
- With the key absent nothing is checked; with the key set and the file missing the push is refused.
