# E_ADOPT_UNAVAILABLE

Who acts: `owner`

## What happened

`aos adopt` could not run: the folder is not a git work tree, so the history and the tracked files cannot be read (SPEC-0006 §3, exit 2). Nothing was written.

## What to do next

**Run aos adopt inside the git work tree of the project (it needs the repository and its history).** (owner)

1. Owner: `cd` into the project (or pass `--root <dir>`) and run `node plugins/analucia/bin/aos.mjs adopt` again.
2. A project that is not under git yet has nothing to audit: run `git init`, commit, then `aos init`.

## Patterns

- Use the `aos` commands for every state change; they apply the rules for you.

## Trade-offs

- The audit reports "could not run" instead of an empty, clean-looking report.

## Gotchas

- Nothing was written when this error appeared; fix the cause and run the command again.
