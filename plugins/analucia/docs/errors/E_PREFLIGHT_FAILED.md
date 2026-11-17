# E_PREFLIGHT_FAILED

Who acts: `director`

## What happened

One or more `preflight` checks of the order's verify file failed on the tree as it is: a tool, a file or the test baseline the order needs before any work is missing. The message names the failing checks and the evidence file with their output. `aos admit` admitted nothing; `aos run start` started nothing: no `run.started` was written and no attempt was consumed.

## What to do next

**Put in place what the failing preflight checks name (a tool, a file, the test baseline), or correct the check in a new draft, then run aos preflight again; no attempt was consumed.** (director)

1. Read the evidence file named in the message (`.analucia/evidence/<ID>/preflight-NN.txt`): each check, its command, its exit code and its output.
2. If the prerequisite is the owner's to provide (a tool to install, an access), tell the owner in one line what is missing.
3. `node plugins/analucia/bin/aos.mjs preflight <ID>` again; when it ends with `OK:`, the order can be placed or started.

## Patterns

- Write the preflight with the order, and run it on the draft before asking the owner to place anything.

## Trade-offs

- The checks run at admission and again at every run start: a slow preflight slows both. Keep them to what the order really needs to begin.

## Gotchas

- A verify file without `preflight` is valid; `aos admit` says in one line that it has none.
- The preflight proves the start, not the result: the `checks` still decide whether the order is verified.
