# E_MOVING_REF

Who acts: `director`

## What happened

`aos validate` (or `aos admit`) found a verify check that ends a git range at a ref that moves: `HEAD` in any form, `main`, `master`, a ref under `origin/`, `upstream/`, `refs/heads/` or `refs/remotes/`, or a branch of the repository. Such a check passes today and fails as soon as later work moves the ref, so the order can no longer be verified or signed (ORD-0028 check 11, AMD-0008). The message names the check and the token.

## What to do next

**Replace the moving ref named in the message (HEAD, a branch or a remote ref) with a commit SHA or {order_commit} in the verify file, then run aos validate again.** (director)

1. Wrong: `git diff --quiet 8ea118d HEAD -- core`.
2. Right: `git diff --quiet 8ea118d {order_commit} -- core` (the newest commit with the trailer `Analucia-Order: ORD-NNNN`), or a fixed SHA.
3. Refresh `director.lock`, then `node plugins/analucia/bin/aos.mjs validate`.

## Patterns

- Only the end of a range is judged. Single revisions are fine: `--ref HEAD` to build the current tree, `git merge-base --is-ancestor <sha> HEAD`, `git rev-parse --verify <ref>`, `git log --grep …`.
- Template: `plugins/analucia/templates/verify-file.example.json`.

## Trade-offs

- Orders admitted before plugin 0.3.0 get a warning, not an error, so `aos validate` keeps exiting 0; the director amends them only if a check actually breaks.

## Gotchas

- `A..` with an empty right side means `A..HEAD` and is rejected too.
- An executor never fixes a verify file: it finishes the run with `needs_decision`.
