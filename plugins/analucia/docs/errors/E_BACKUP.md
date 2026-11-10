# E_BACKUP

Who acts: `executor`

## What happened

`aos backup` could not build or push the snapshot: one git step failed (for example the remote is not reachable, the push was refused by the pre-push guard, or the folder is not a git work tree). The current branch, the index, the working tree and `main` were not touched; nothing was recorded in the log (ORD-0024).

## What to do next

**Read the git step named in the message, fix it (remote reachable, account, a git work tree), then run aos backup again.** (executor)

1. Run `git ls-remote origin` to check the remote and the account.
2. If the pre-push guard refused, read its message (`node plugins/analucia/bin/aos.mjs check-push`).
3. Run `node plugins/analucia/bin/aos.mjs backup` again.

## Patterns

- Run a backup at the end of each working session, so no machine holds work that exists nowhere else.

## Trade-offs

- The snapshot never forces a push: a second backup on the same day goes on top of the first.

## Gotchas

- Git-ignored files are never in a backup; secrets live in the password manager, not in the repository.
