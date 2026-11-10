# E_SECRET_IN_URL

Who acts: `owner`

## What happened

The remote URL carries a credential (`https://user:secret@…`). The push was refused before anything left the machine, and the message shows the URL with the secret masked (SPEC-0004 §5).

## What to do next

**Remove the credential from the remote URL with git remote set-url, rotate it, then push again.** (owner)

1. Owner: run the `git remote set-url origin https://…` command the refusal printed: it carries the github_owner as the user name only and the real repository (the credential manager supplies the secret).
2. Rotate the exposed credential at the provider.
3. Check with `node plugins/analucia/bin/aos.mjs check-push`.

## Patterns

- A remote URL holds the user name only.

## Trade-offs

- None specific: the rule is cheap to follow and the check costs nothing at runtime.

## Gotchas

- `git remote -v` prints the full URL; a credential there is visible to anyone who sees the terminal.
