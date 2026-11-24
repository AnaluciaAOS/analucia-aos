# E_DRAFT_ASSUMES

Who acts: `director`

## What happened

`aos drafts` (the preflight of a draft) found that what the draft assumes is not true on this machine: its key `base:` is not the real `main` (or `origin/main`) nor an ancestor with only director commits after it, or a file, a command or a service named in `assumes:` is not there (OBS-202, OBS-203). The message names the base or the missing thing and what putting it there would cost.

## What to do next

**Fix what the message names (the base, a file, a command or a service the draft assumes), then run aos drafts again.** (director)

1. A stale base: write the draft again on the real `main` and change `base:` to that commit.
2. A missing file or service: add the work that makes it to the draft, or write the order that does first.
3. A missing command: installing it changes the owner's machine, so he decides it; do not assume it.

## Patterns

- `base: <sha>` is accepted when it is the tip of `main` or of `origin/main`, or an ancestor of it with only `.analucia/` or `core/` files changed after it.
- `assumes: [file:<path>, command:<name>, service:<url>]`; without a prefix an http(s) address is a service and anything else is a file of the project.

## Trade-offs

- A service is asked with one request and five seconds; a slow service is reported as missing, and the director asks again.

## Gotchas

- Only local refs are compared: fetch before you trust `origin/main`.
- The check never installs, starts or fetches anything.
